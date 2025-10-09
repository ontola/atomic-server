#!/bin/bash

# Fix all agent files to use correct HuggingFace model references
# and fix YAML syntax issues

AGENT_DIR=".opencode/agent"

# Map old models to new HuggingFace models
declare -A model_mapping=(
    ["Qwen/Qwen2.5-Coder-32B-Instruct"]="huggingface/Qwen/Qwen3-Coder-480B-A35B-Instruct"
    ["Qwen/Qwen2.5-Coder-14B-Instruct"]="huggingface/Qwen/Qwen3-Next-80B-A3B-Instruct"
    ["Qwen/Qwen2.5-Coder-7B-Instruct"]="huggingface/Qwen/Qwen3-Next-80B-A3B-Thinking"
    ["Qwen/Qwen2.5-Coder-1.5B-Instruct"]="huggingface/deepseek-ai/DeepSeek-R1-0528"
)

for agent_file in "$AGENT_DIR"/*.md; do
    if [ -f "$agent_file" ]; then
        echo "Fixing $agent_file..."
        
        # Fix model references
        for old_model in "${!model_mapping[@]}"; do
            new_model="${model_mapping[$old_model]}"
            sed -i "s|^model: $old_model|model: $new_model|g" "$agent_file"
        done
        
        # Fix permissions vs permission YAML key
        sed -i 's/^permissions:/permission:/g' "$agent_file"
        
        # Fix tools section (remove tools section as it's not needed in the new format)
        sed -i '/^tools:/,/^$/d' "$agent_file"
    fi
done

echo "All agent files have been fixed!"
echo ""
echo "Summary of changes:"
echo "1. Updated model references to use valid HuggingFace models"
echo "2. Fixed 'permissions:' to 'permission:' (singular)"
echo "3. Removed 'tools:' section (not needed in new format)"
echo ""
echo "Make sure to set your HF_TOKEN environment variable!"