use ort::execution_providers::ExecutionProviderDispatch;

/// ONNX Runtime execution providers used when `config.gpu_indexing` is enabled (fastembed embedding + reranker).
pub(crate) fn fastembed_gpu_execution_providers() -> Vec<ExecutionProviderDispatch> {
    let mut execution_providers = Vec::new();

    #[cfg(target_os = "macos")]
    {
        execution_providers.push(
            ort::execution_providers::CoreMLExecutionProvider::default()
                .with_compute_units(
                    ort::execution_providers::coreml::ComputeUnits::CPUAndNeuralEngine,
                )
                .with_model_format(ort::execution_providers::coreml::ModelFormat::MLProgram)
                .build(),
        );
    }
    #[cfg(target_os = "windows")]
    {
        execution_providers
            .push(ort::execution_providers::DirectMLExecutionProvider::default().build());
        execution_providers.push(ort::execution_providers::CUDAExecutionProvider::default().build());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        execution_providers.push(ort::execution_providers::CUDAExecutionProvider::default().build());
    }

    execution_providers
}
