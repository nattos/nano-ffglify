// Minimal Metal compute shader for sanity testing
// Writes a single float value (123.0) to a buffer

#include <metal_stdlib>
using namespace metal;

kernel void main_kernel(
    device float* output [[buffer(0)]],
    uint id [[thread_position_in_grid]]
) {
    if (id == 0) {
        output[0] = 123.0f;
    }
}
