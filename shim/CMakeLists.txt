cmake_minimum_required(VERSION 3.13)
project(soloist_pulse_shim C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

add_compile_options(-Wall -Wextra -Werror -Wno-unused-parameter -O2)

find_package(PkgConfig REQUIRED)
pkg_check_modules(ALSA REQUIRED alsa)

add_library(pulse SHARED
    src/mainloop.c
    src/support.c
    src/context.c
    src/stream.c
    src/ring.c
    src/resample.c
)

target_include_directories(pulse PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src
    ${ALSA_INCLUDE_DIRS}
)

target_link_libraries(pulse PRIVATE ${ALSA_LIBRARIES} m pthread)

set_target_properties(pulse PROPERTIES
    OUTPUT_NAME pulse
    SOVERSION 0
    VERSION 0.3.1
    LINK_FLAGS "-Wl,--version-script=${CMAKE_SOURCE_DIR}/pulse.sym"
)

install(TARGETS pulse LIBRARY DESTINATION lib)
