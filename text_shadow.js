let TextControlApi = function () {
    const TEXT_SHADOW_PROTECT = 0x45820;
    const TEXT_SHADOW_UNPROTECT = 0x45821;
    const TEXT_SHADOW_CLEAR_ALL = 0x45822;

    const PAGE_SIZE = Process.pageSize;
    const PAGE_MASK = ~(PAGE_SIZE - 1);
    const SHADOW_POOL_PAGES = 0x200;
    const SHADOW_POOL_CHUNK_SIZE = PAGE_SIZE * SHADOW_POOL_PAGES;

    const PROT_READ = 0x1;
    const PROT_WRITE = 0x2;
    const PROT_EXEC = 0x4;
    const MAP_PRIVATE = 0x02;
    const MAP_ANONYMOUS = 0x20;

    class TextControl {
        constructor() {
            this._shadowPages = new Map();          // pageKey -> { original: NativePointer }
            this._shadowPool = { chunks: [], current: null };

            // pageKey -> Sety -> Set<pcString>: 每个受保护页对应的所有已注册蹦床 PC
            this._protectedPages = new Map();

            this.useMemoryProtect = true;
            this.useTextShadowProtect = true;

            // 异步合批: writeTextProtect 入队, 5ms 内聚合同段/同页, 共用一次 rwx 窗口.
            // 同页迟到 hook 走 "JS 先 unprotect -> 共用 rwx -> CModule 批量 protect" 的序列,
            // 白名单 gap 压到 μs 级.
            this._queue = [];
            this._flushTimer = null;
            this._flushDelayMs = 5;
            this._icacheLine = 64;                  // ARM64 常见 cacheline 粒度

            this._initFunctions();
            this._initCModule();
        }

        _initFunctions() {
            const libc = Process.getModuleByName('libc.so');
            const findExport = name => {
                try {
                    return libc.getExportByName(name);
                } catch (_) {
                    return null;
                }
            };

            const mmapPtr = findExport('mmap');
            if (mmapPtr === null) throw new Error('[ts] mmap not found in libc.so');
            this._mmap = new NativeFunction(
                mmapPtr, 'pointer', ['pointer', 'ulong', 'int', 'int', 'int', 'int64']);

            const mprotectPtr = findExport('mprotect');
            if (mprotectPtr !== null) {
                this._mprotect = new NativeFunction(mprotectPtr, 'int', ['pointer', 'ulong', 'int']);
            }

            this._prctlPtr = findExport('prctl');
            if (this._prctlPtr === null) throw new Error('[ts] prctl not found in libc.so');
            this._prctl = new NativeFunction(
                this._prctlPtr, 'int', ['int', 'uint64', 'uint64', 'uint64', 'uint64']);

            const munmapPtr = findExport('munmap');
            if (munmapPtr !== null) {
                this._munmap = new NativeFunction(munmapPtr, 'int', ['pointer', 'ulong']);
            }

            const memcpyPtr = findExport('memcpy');
            if (memcpyPtr !== null) {
                this._memcpy = new NativeFunction(memcpyPtr, 'pointer', ['pointer', 'pointer', 'ulong']);
            }

            const clearCachePtr = findExport('__clear_cache');
            if (clearCachePtr !== null) {
                this._clearCache = new NativeFunction(clearCachePtr, 'void', ['pointer', 'pointer']);
            }
        }

        _initCModule() {
            // 把 prctl(PROTECT) 的循环下沉到 native, 避免 V8<->C 边界开销;
            // 同页 N 个 PC 的白名单重建在 μs 级内完成, CRC 线程碰撞到的概率显著降低.
            try {
                const src = `
extern int prctl(int op, unsigned long a, unsigned long b, unsigned long c, unsigned long d);

#define TEXT_SHADOW_PROTECT    0x45820
#define TEXT_SHADOW_UNPROTECT  0x45821

/* pcs: uint64[], 每个元素是一个蹦床入口 PC.
 * orig: 该页 saveOriginal 分配的 clean 页缓冲区地址.
 * 内核 protect_page: 首调 PC 分配 alt 并从 orig 拷贝, 后续同页 PC 走 append. */
int ts_protect_batch(const unsigned long *pcs, unsigned long orig, int n) {
    int r = 0;
    for (int i = 0; i < n; ++i) {
        r = prctl(TEXT_SHADOW_PROTECT, pcs[i], orig, 0, 0);
    }
    return r;
}

/* 同页已保护场景: 解保护后立即批量重建, 尽量压短白名单 gap. */
int ts_reprotect_batch(unsigned long page_base,
                       const unsigned long *pcs,
                       unsigned long orig,
                       int n) {
    prctl(TEXT_SHADOW_UNPROTECT, page_base, 0, 0, 0);
    int r = 0;
    for (int i = 0; i < n; ++i) {
        r = prctl(TEXT_SHADOW_PROTECT, pcs[i], orig, 0, 0);
    }
    return r;
}
`;
                this._cm = new CModule(src, { prctl: this._prctlPtr });
                this._cmProtectBatch = new NativeFunction(
                    this._cm.ts_protect_batch, 'int', ['pointer', 'uint64', 'int']);
                this._cmReprotectBatch = new NativeFunction(
                    this._cm.ts_reprotect_batch, 'int', ['uint64', 'pointer', 'uint64', 'int']);
            } catch (e) {
                console.log('[ts] CModule init failed, fallback to JS loop:', (e && e.message) || e);
                this._cm = null;
            }
        }

        // ---------- 基础工具 ----------

        _pageOf(addr) {
            if (typeof addr === 'number') addr = ptr(addr);
            return addr.and(PAGE_MASK);
        }

        _alignUp(size, align) {
            return (size + align - 1) & ~(align - 1);
        }

        _mapShadowChunk(minSize) {
            const chunkSize = Math.max(SHADOW_POOL_CHUNK_SIZE, this._alignUp(minSize, PAGE_SIZE));
            const chunkBase = this._mmap(
                ptr(0), chunkSize, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
            if (chunkBase.isNull() || chunkBase.equals(ptr('-1'))) {
                throw new Error('[ts] mmap shadow pool failed');
            }
            const chunk = { base: chunkBase, size: chunkSize, offset: 0 };
            this._shadowPool.chunks.push(chunk);
            this._shadowPool.current = chunk;
            console.log('[ts] mmap shadow chunk ' + chunkBase + ' size=0x' + chunkSize.toString(16));
            return chunk;
        }

        _allocShadowBytes(size) {
            const bytes = this._alignUp(size, PAGE_SIZE);
            let chunk = this._shadowPool.current;
            if (chunk === null || (chunk.offset + bytes) > chunk.size) {
                chunk = this._mapShadowChunk(bytes);
            }
            const out = chunk.base.add(chunk.offset);
            chunk.offset += bytes;
            return out;
        }

        // ---------- 对外: 原件 / 保护 / 解保护 ----------

        saveOriginal(addr) {
            const base = this._pageOf(addr);
            const key = base.toString();
            if (this._shadowPages.has(key)) return this._shadowPages.get(key).original;

            const buf = this._allocShadowBytes(PAGE_SIZE);
            if (this._memcpy !== undefined) this._memcpy(buf, base, PAGE_SIZE);
            else Memory.copy(buf, base, PAGE_SIZE);

            this._shadowPages.set(key, { original: buf });
            return buf;
        }

        _prctlProtect(func) {
            const base = this._pageOf(func);
            const entry = this._shadowPages.get(base.toString());
            if (!entry || !entry.original) {
                console.log('[ts] ERROR: saveOriginal not called for page ' + base);
                return -1;
            }
            return this._prctl(
                TEXT_SHADOW_PROTECT,
                uint64(func.toString()),
                uint64(entry.original.toString()),
                uint64(0), uint64(0));
        }

        protect(func) {
            const base = this._pageOf(func);
            const pageKey = base.toString();
            const pcKey = ptr(func.toString()).toString();
            const ret = this._prctlProtect(func);
            if (ret === 0 || ret > 0) {
                let set = this._protectedPages.get(pageKey);
                if (!set) { set = new Set(); this._protectedPages.set(pageKey, set); }
                set.add(pcKey);
            }
            return ret;
        }

        unprotect(func) {
            const base = this._pageOf(func);
            const pageKey = base.toString();
            const ret = this._prctl(TEXT_SHADOW_UNPROTECT, uint64(base.toString()), 0, 0, 0);
            this._protectedPages.delete(pageKey);
            return ret;
        }

        clearAll() {
            this._protectedPages.clear();
            return this._prctl(TEXT_SHADOW_CLEAR_ALL, 0, 0, 0, 0);
        }

        // ---------- 对外: 异步批量 writeTextProtect ----------

        /**
         * 把一次 "改某 VA 的指令 + 让它被 text-shadow 保护" 的动作入队.
         * 同一个 5ms 窗口内到达的多个请求会合批: 同段共享 rwx 窗口, 同页合并 prctl.
         * callback 必须幂等且快速返回 (内部会在 rwx 窗口里调 Interceptor.attach/replace).
         */
        writeTextProtect(address, callback) {
            const addr = (typeof address === 'number') ? ptr(address) : address;

            // 原件必须同步保存: 合批前 page 仍是 clean, 此时抓最干净.
            this.saveOriginal(addr);

            const r = Process.findRangeByAddress(addr);
            if (!r) return;

            this._queue.push({ addr, callback, range: r });
            this._scheduleFlush();
        }

        _scheduleFlush() {
            if (this._flushTimer !== null) return;
            this._flushTimer = setTimeout(() => {
                this._flushTimer = null;
                try { this._flush(); }
                catch (e) { console.log('[ts] flush error:', (e && e.stack) || e); }
            }, this._flushDelayMs);
        }

        /** 强制立即落盘 (初始化收尾 / 同步语义需求时主动调). */
        flush() {
            if (this._flushTimer !== null) {
                clearTimeout(this._flushTimer);
                this._flushTimer = null;
            }
            this._flush();
        }

        _flush() {
            const items = this._queue;
            this._queue = [];
            if (items.length === 0) return;

            // 1) 按 page 分桶
            const byPage = new Map();
            for (const it of items) {
                const pk = this._pageOf(it.addr).toString();
                let bucket = byPage.get(pk);
                if (!bucket) { bucket = []; byPage.set(pk, bucket); }
                bucket.push(it);
            }

            // 2) 搜集所有 range, 一次 rwx 窗口覆盖整个 batch
            const rangeMap = new Map();
            for (const it of items) {
                if (it.range) rangeMap.set(it.range.base.toString(), it.range);
            }
            const ranges = Array.from(rangeMap.values());

            // 3) 同页已保护: 先 JS unprotect 让接下来的 patch 落进 shadow.
            //    必须在 rwx 之前, 否则 mprotect_before 内核钩子会把 PFN 预翻成 alt,
            //    Frida 的写动作会污染 alt 页, 导致 CRC 读到 hook 字节.
            const perPage = new Map(); // pageKey -> { pageBase, items, preservedPcs | null }
            for (const [pk, pageItems] of byPage) {
                const pageBase = this._pageOf(pageItems[0].addr);
                let preservedPcs = null;
                if (this.useTextShadowProtect && this._protectedPages.has(pk)) {
                    preservedPcs = Array.from(this._protectedPages.get(pk));
                    this.unprotect(pageItems[0].addr);
                }
                perPage.set(pk, { pageBase, items: pageItems, preservedPcs });
            }

            // 4) 单一 rwx 窗口 -> 全部 attach/replace -> flush -> 恢复
            if (this.useMemoryProtect) {
                const origProt = ranges.map(r => r.protection);
                for (const r of ranges) Memory.protect(r.base, r.size, 'rwx');
                for (const it of items) {
                    try { it.callback(); } catch (e) { console.log('[ts] cb error:', e); }
                }
                Interceptor.flush();
                for (let i = 0; i < ranges.length; ++i) {
                    Memory.protect(ranges[i].base, ranges[i].size, origProt[i]);
                }
            } else {
                for (const it of items) {
                    try { it.callback(); } catch (e) { console.log('[ts] cb error:', e); }
                }
                Interceptor.flush();
            }

            if (!this.useTextShadowProtect) return;

            // 5) 每个 page 一次 CModule 批量 protect (新 PC + 保留 PC 合并去重)
            for (const [pk, info] of perPage) {
                const entry = this._shadowPages.get(pk);
                if (!entry || !entry.original) continue;

                const pcSet = new Set();
                const pcList = [];
                for (const it of info.items) {
                    const k = ptr(it.addr.toString()).toString();
                    if (!pcSet.has(k)) { pcSet.add(k); pcList.push(it.addr); }
                }
                if (info.preservedPcs) {
                    for (const pcStr of info.preservedPcs) {
                        if (pcSet.has(pcStr)) continue;
                        pcSet.add(pcStr);
                        pcList.push(ptr(pcStr));
                    }
                }

                const n = pcList.length;
                const pcsBuf = Memory.alloc(n * 8);
                for (let i = 0; i < n; ++i) {
                    pcsBuf.add(i * 8).writeU64(uint64(pcList[i].toString()));
                }

                const origU64 = uint64(entry.original.toString());
                let ret;
                if (this._cmProtectBatch) {
                    ret = this._cmProtectBatch(pcsBuf, origU64, n);
                } else {
                    ret = 0;
                    for (const pc of pcList) {
                        ret = this._prctl(TEXT_SHADOW_PROTECT,
                            uint64(pc.toString()), origU64, uint64(0), uint64(0));
                    }
                }

                // 同步 JS 端白名单状态
                let set = this._protectedPages.get(pk);
                if (!set) { set = new Set(); this._protectedPages.set(pk, set); }
                for (const pc of pcList) set.add(ptr(pc.toString()).toString());

                // 6) protect 之后按 addr ±cacheline 做局部 icache 失效, 避免整段 .so 遍历
                if (this._clearCache !== undefined) {
                    const line = this._icacheLine;
                    const mask = ~(line - 1);
                    for (const it of info.items) {
                        const lo = it.addr.and(mask);
                        const hi = it.addr.add(16).add(line - 1).and(mask);
                        this._clearCache(lo, hi);
                    }
                }

                // 7) 对每个 hook 地址 readU8 一次, 触发 do_page_fault_before 走一遍 alt 分支,
                //    "热身" shadow/alt 双映射, 确保后续外部读立即命中 alt. 只读不打印.
                for (const it of info.items) {
                    try { it.addr.readU8(); } catch (_) { /* ignore */ }
                }

                if (ret !== 0 && ret <= 0) {
                    console.log(`[ts] batch protect page=${info.pageBase} n=${n} ret=${ret}`);
                }
            }
        }

        // ---------- 同步批量入口 (兼容老接口) ----------

        /**
         * 一次性注册并保护一组 hook. 等价于: 对每个 h 调 writeTextProtect 然后 flush().
         * hookList 元素: { func: NativePointer, onEnter?, onLeave? } 或 { func, replace }.
         */
        batchHookAndProtect(hookList) {
            for (const h of hookList) {
                this.writeTextProtect(h.func, () => {
                    if (typeof h.replace === 'function' || h.replace instanceof NativePointer) {
                        Interceptor.replace(h.func, h.replace);
                    } else {
                        Interceptor.attach(h.func, { onEnter: h.onEnter, onLeave: h.onLeave });
                    }
                });
            }
            this.flush();
        }
    }

    // 单例 + 对外导出
    let _tc = null;
    function getTextControl() {
        if (_tc === null) _tc = new TextControl();
        return _tc;
    }

    return {
        saveOriginal: function (a) { getTextControl().saveOriginal(ptr(a)); },
        protect: function (a) { return getTextControl().protect(ptr(a)); },
        unprotect: function (a) { return getTextControl().unprotect(ptr(a)); },
        clearAll: function () { return getTextControl().clearAll(); },
        writeTextProtect: function (address, callback) {
            // RPC 场景下一般只想保护 (不带 patch callback), 直接入队一个 no-op.
            getTextControl().writeTextProtect(ptr(address), callback);
        },
        flush: function () { getTextControl().flush(); },
        batchHookAndProtect: function (hookList) { getTextControl().batchHookAndProtect(hookList); }
    };
}();

rpc.exports = TextControlApi;

// ---------- 使用示例: hook open ----------
// open(2) 签名: int open(const char *pathname, int flags, ...);
//   args[0] = pathname (const char *)
//   args[1] = flags   (int)
(function hookOpenExample() {
    const libc = Process.getModuleByName('libc.so');
    let openPtr = null;
    try {
        openPtr = libc.getExportByName('open');
    } catch (_) {
        openPtr = null;
    }
    if (openPtr === null) {
        console.log('[ts] open not found');
        return;
    }
    console.log('[ts] open @ ' + openPtr);

    // 走异步合批: writeTextProtect 入队后 ~5ms 内自动 flush.
    // 如果后面还会继续追加 hook, 不用手动 flush, 队列会自动合并.
    TextControlApi.writeTextProtect(openPtr, () => {
        Interceptor.attach(openPtr, {
            onEnter(args) {
                const path = args[0].isNull() ? '<null>' : args[0].readUtf8String();
                this._path = path;
                console.log('[open] ' + path);
            },
            onLeave(retval) {
                if (retval.toInt32() < 0) {
                    console.log('[open] ' + this._path + ' -> ERR ' + retval.toInt32());
                }
            }
        });
    });

    // 如果想立刻就绪 (不等 5ms 合批窗口), 显式 flush:
    // TextControlApi.flush();
})();
