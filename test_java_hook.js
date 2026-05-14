"use strict";

const TAG = "[java-hook-test]";

function log(message) {
    console.log(TAG + " " + message);
}

function main() {
    if (!Java.available) {
        log("Java is not available");
        return;
    }

    Java.perform(function () {
        log("Java.perform ok");

        const Application = Java.use("android.app.Application");
        const attach = Application.attach.overload("android.content.Context");
        attach.implementation = function (context) {
            const packageName = context.getPackageName().toString();
            Java.classFactory.loader = context.getClassLoader();
            log("Application.attach package=" + packageName);
            return attach.call(this, context);
        };

        const Activity = Java.use("android.app.Activity");
        const onResume = Activity.onResume.overload();
        onResume.implementation = function () {
            log("Activity.onResume class=" + this.getClass().getName());
            return onResume.call(this);
        };

        log("hooks installed");
    });
}

setImmediate(main);
