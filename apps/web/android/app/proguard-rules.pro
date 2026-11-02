# Shap Pocket: R8 rules for the release build.
#
# The app's own code is JavaScript in the web view, so what R8 shrinks and renames here is the
# Android libraries. The Capacitor bridge and its plugins are reached by name from JavaScript,
# so they're kept whole (Capacitor's own rules cover the annotations; these are belt and braces).
-keep class com.getcapacitor.** { *; }
-keep class com.capacitorjs.plugins.** { *; }
-keep class io.capawesome.capacitorjs.** { *; }
-keep class com.aparajita.capacitor.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Readable crash reports in Play Console (upload the mapping file from the build artifact).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
