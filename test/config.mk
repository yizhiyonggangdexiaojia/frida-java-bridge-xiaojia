ANDROID_SDK_ROOT ?= $(shell echo ~/Android/Sdk)
ANDROID_NDK_ROOT ?= $(shell echo ~/.local/opt/android-ndk-r25b)
ANDROID_ARCH ?= arm64
ANDROID_ABI ?= arm64-v8a
ANDROID_API_LEVEL ?= 33
ANDROID_BINDIR ?= /system/bin
ANDROID_LIBDIR ?= /system/lib64
ANDROID_VM ?= libart.so
APEX_LIBDIRS ?= /apex/com.android.runtime/$(shell basename $(ANDROID_LIBDIR)):/apex/com.android.art/$(shell basename $(ANDROID_LIBDIR))
DEBUG_PORT ?= 5042
