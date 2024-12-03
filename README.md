### frida-java-bridge抹除特征版本

初始化模块

```
npm install
```



需要使用可以直接

```
npm run build
```



然后执行

```
frida -H ip:port -f 包名 -l _agent.js
```



如果需要写代码，请在index.js下写代码，需要导出请使用

```
global.函数名称 = 函数名称
```

