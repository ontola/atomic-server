cmake_minimum_required(VERSION 3.10)

set(PROJECT_NAME "atomic_lib")
project(${PROJECT_NAME} LANGUAGES CXX)

include("../cargokit/cmake/cargokit.cmake")
apply_cargokit(${PROJECT_NAME} ../rust rust_lib_atomic_lib "")

set(atomic_lib_bundled_libraries
  "${${PROJECT_NAME}_cargokit_lib}"
  PARENT_SCOPE
)
