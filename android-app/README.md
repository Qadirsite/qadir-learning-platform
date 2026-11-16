# تطبيق قادر Android

هذا التطبيق WebView خفيف يفتح نسخة قادر المنشورة مع دعم:

- تسجيل الصوت للمساعد.
- اختيار ورفع الملفات والصور من صفحات الموقع.
- أزرار الرجوع داخل التطبيق.
- فتح الروابط الخارجية في المتصفح.

رابط السيرفر مضبوط في `app/src/main/java/com/qadir/learning/MainActivity.java` داخل الثابت `SERVER_URL`. غيّره إلى رابط السيرفر الجديد بعد نشره من GitHub/منصة الاستضافة، ثم أعد البناء.

## البناء

```bash
export ANDROID_HOME=/home/ubuntu/android-sdk
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
cd android-app
./gradlew assembleDebug
```

يخرج الملف في:

`app/build/outputs/apk/debug/app-debug.apk`
