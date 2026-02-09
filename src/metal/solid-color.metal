#include <metal_stdlib>
using namespace metal;

kernel void solid_color(texture2d<half, access::write> output [[texture(0)]],
                        uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= output.get_width() || gid.y >= output.get_height()) {
        return;
    }

    // Magenta color (1.0, 0.0, 1.0, 1.0)
    output.write(half4(1.0, 0.0, 1.0, 1.0), gid);
}
