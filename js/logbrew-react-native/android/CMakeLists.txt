cmake_minimum_required(VERSION 3.22.1)
project(logbrew_android_diagnostics LANGUAGES CXX)

add_library(logbrew_android_diagnostics SHARED src/main/cpp/android_diagnostics.cpp)
target_compile_features(logbrew_android_diagnostics PRIVATE cxx_std_17)
target_compile_options(logbrew_android_diagnostics PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
target_link_libraries(logbrew_android_diagnostics PRIVATE dl)
