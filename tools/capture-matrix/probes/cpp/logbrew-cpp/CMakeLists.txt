cmake_minimum_required(VERSION 3.16)
project(capture_probe LANGUAGES CXX)

find_package(LogBrew CONFIG REQUIRED)
add_executable(probe probe.cpp)
target_compile_options(probe PRIVATE -Wall -Wextra -Wpedantic -Werror)
target_link_libraries(probe PRIVATE LogBrew::HttpTransport)
