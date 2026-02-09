// Generated C++ code from IR
// Entry point: fn_main_cpu

void func_fn_main_cpu(EvalContext& ctx);

void func_fn_main_cpu(EvalContext& ctx) {
    auto n_out_size = std::array<float, 2>{static_cast<float>(ctx.resources[0]->width), static_cast<float>(ctx.resources[0]->height)};
    {
        std::vector<float> _shader_args;
        _shader_args.push_back(static_cast<float>(ctx.getInput("brightness")));
        ctx.dispatchShader("fn_brightness_gpu", static_cast<int>(n_out_size[0]), static_cast<int>(n_out_size[1]), 1, _shader_args);
    }
}

// Entry point wrapper for harness
void func_main(EvalContext& ctx) { func_fn_main_cpu(ctx); }

// FFGL Plugin Helpers
void PLUGIN_CLASS::init_plugin() {
    SetParamInfo(0, "brightness", FF_TYPE_STANDARD, 0.5f);
}

void PLUGIN_CLASS::map_params(EvalContext& ctx) {
    ctx.inputs["brightness"] = GetFloatParameter(0);
}
