cmake_minimum_required(VERSION 3.16)

project(LogBrew VERSION 0.2.3 LANGUAGES CXX)

include(GNUInstallDirs)
include(CMakePackageConfigHelpers)

option(LOGBREW_BUILD_HTTP_TRANSPORT "Build the optional libcurl transport" OFF)
option(LOGBREW_BUILD_TESTS "Build SDK tests" OFF)
option(LOGBREW_BUILD_EXAMPLES "Build SDK examples" OFF)

add_library(logbrew src/logbrew.cpp)
add_library(LogBrew::LogBrew ALIAS logbrew)
set_target_properties(logbrew PROPERTIES EXPORT_NAME LogBrew)
target_compile_features(logbrew PUBLIC cxx_std_17)
target_include_directories(
  logbrew
  PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
)

if(LOGBREW_BUILD_HTTP_TRANSPORT)
  find_package(CURL REQUIRED)
  add_library(logbrew_http_transport src/logbrew_http_transport.cpp)
  add_library(LogBrew::HttpTransport ALIAS logbrew_http_transport)
  set_target_properties(logbrew_http_transport PROPERTIES EXPORT_NAME HttpTransport)
  target_link_libraries(logbrew_http_transport PUBLIC LogBrew::LogBrew CURL::libcurl)
endif()

if(LOGBREW_BUILD_TESTS)
  enable_testing()
  foreach(test_name IN ITEMS logbrew rich_context)
    add_executable(logbrew_test_${test_name} tests/test_${test_name}.cpp)
    target_link_libraries(logbrew_test_${test_name} PRIVATE LogBrew::LogBrew)
    add_test(NAME ${test_name} COMMAND logbrew_test_${test_name})
  endforeach()
endif()

if(LOGBREW_BUILD_EXAMPLES)
  foreach(example_name IN ITEMS readme_example real_user_smoke trace_correlation)
    add_executable(logbrew_${example_name} examples/${example_name}.cpp)
    target_link_libraries(logbrew_${example_name} PRIVATE LogBrew::LogBrew)
  endforeach()
  if(LOGBREW_BUILD_HTTP_TRANSPORT)
    add_executable(logbrew_http_transport_example examples/http_transport.cpp)
    target_link_libraries(logbrew_http_transport_example PRIVATE LogBrew::HttpTransport)
  endif()
endif()

install(
  TARGETS logbrew
  EXPORT LogBrewTargets
  ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
  LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
  RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
  INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
)
if(LOGBREW_BUILD_HTTP_TRANSPORT)
  install(
    TARGETS logbrew_http_transport
    EXPORT LogBrewTargets
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
  )
endif()
install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(
  EXPORT LogBrewTargets
  FILE LogBrewTargets.cmake
  NAMESPACE LogBrew::
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/LogBrew
)

configure_package_config_file(
  cmake/LogBrewConfig.cmake.in
  ${CMAKE_CURRENT_BINARY_DIR}/LogBrewConfig.cmake
  INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/LogBrew
)
write_basic_package_version_file(
  ${CMAKE_CURRENT_BINARY_DIR}/LogBrewConfigVersion.cmake
  VERSION ${PROJECT_VERSION}
  COMPATIBILITY SameMajorVersion
)
install(
  FILES
    ${CMAKE_CURRENT_BINARY_DIR}/LogBrewConfig.cmake
    ${CMAKE_CURRENT_BINARY_DIR}/LogBrewConfigVersion.cmake
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/LogBrew
)
