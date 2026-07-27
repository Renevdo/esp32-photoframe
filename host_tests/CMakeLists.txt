cmake_minimum_required(VERSION 3.14)
project(esp32_photoframe_tests)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Fetch Google Test
include(FetchContent)
FetchContent_Declare(
  googletest
  GIT_REPOSITORY https://github.com/google/googletest.git
  GIT_TAG v1.14.0
)
# For Windows: Prevent overriding the parent project's compiler/linker settings
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

# Fetch cJSON (used by the sync-ops parser; the firmware gets it from ESP-IDF)
FetchContent_Declare(
  cjson
  GIT_REPOSITORY https://github.com/DaveGamble/cJSON.git
  GIT_TAG v1.7.18
)
set(ENABLE_CJSON_TEST OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_AND_STATIC_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(cjson)

# Enable testing
enable_testing()

# Cron engine tests
add_executable(
  cron_test
  test_cron.cpp
  ../main/cron.c
)

target_link_libraries(
  cron_test
  GTest::gtest_main
)

target_include_directories(
  cron_test
  PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/../main
)

# Wake-schedule simulation (early-wake re-sleep loop vs. the real cron engine)
add_executable(
  wake_schedule_test
  test_wake_schedule.cpp
  ../main/cron.c
)

target_link_libraries(
  wake_schedule_test
  GTest::gtest_main
)

target_include_directories(
  wake_schedule_test
  PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/../main
)

# Sync ops parser tests (deploy-on-wake album sync)
add_executable(
  sync_ops_test
  test_sync_ops.cpp
  ../main/sync_ops.c
)

target_link_libraries(
  sync_ops_test
  GTest::gtest_main
  cjson
)

target_include_directories(
  sync_ops_test
  PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/../main
  ${cjson_SOURCE_DIR}
)

# Discover tests
include(GoogleTest)
gtest_discover_tests(cron_test)
gtest_discover_tests(wake_schedule_test)
gtest_discover_tests(sync_ops_test)
