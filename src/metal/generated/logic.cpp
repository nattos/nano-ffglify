// Generated C++ code from IR
// Entry point: fn_main_cpu

void func_fn_main_cpu(EvalContext& ctx);

void func_fn_main_cpu(EvalContext& ctx) {
    auto n_get_tex_size = std::array<float, 2>{static_cast<float>(ctx.resources[0]->width), static_cast<float>(ctx.resources[0]->height)};
    {
        std::vector<float> _shader_args;
        _shader_args.push_back(ctx.getInput("scale"));
        _shader_args.push_back(ctx.getInput("time"));
        ctx.dispatchShader("fn_noise_gpu", static_cast<int>(n_get_tex_size[0]), static_cast<int>(n_get_tex_size[1]), 1, _shader_args);
    }
}

// Entry point wrapper for harness
void func_main(EvalContext& ctx) { func_fn_main_cpu(ctx); }
