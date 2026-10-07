# JSch loads algorithms by class name; retain its and BC's implementations.
-keep class com.jcraft.jsch.** { *; }
-keep class org.bouncycastle.** { *; }
-dontwarn org.slf4j.**
-dontwarn org.apache.logging.**
-dontwarn org.newsclub.net.unix.**
-dontwarn com.sun.jna.**
# Optional desktop Kerberos/LDAP code is unused: authentication is password/publickey only.
-dontwarn org.ietf.jgss.**
-dontwarn javax.naming.**
