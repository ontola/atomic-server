#!/bin/bash

# Properly fix all agent files with correct YAML frontmatter

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
        
        # Extract the content between --- markers
        awk '
        BEGIN { in_frontmatter = 0; frontmatter = ""; content = ""; line_num = 0 }
        /^---$/ { 
            if (line_num == 0) { 
                in_frontmatter = 1; 
                line_num++; 
                next 
            } else if (in_frontmatter) { 
                in_frontmatter = 0; 
                next 
            }
        }
        {
            if (in_frontmatter) {
                frontmatter = frontmatter $0 "\n"
            } else {
                content = content $0 "\n"
            }
        }
        END {
            # Process frontmatter
            gsub(/permissions:/, "permission:", frontmatter)
            gsub(/tools:/, "", frontmatter)
            gsub(/write: [a-z]*/, "", frontmatter)
            gsub(/edit: [a-z]*/, "", frontmatter)
            gsub(/bash: [a-z]*/, "", frontmatter)
            gsub(/read: [a-z]*/, "", frontmatter)
            gsub(/grep: [a-z]*/, "", frontmatter)
            gsub(/glob: [a-z]*/, "", frontmatter)
            gsub(/webfetch: [a-z]*/, "", frontmatter)
            
            # Update model references
            gsub(/model: Qwen\/Qwen2\.5-Coder-32B-Instruct/, "model: huggingface/Qwen/Qwen3-Coder-480B-A35B-Instruct", frontmatter)
            gsub(/model: Qwen\/Qwen2\.5-Coder-14B-Instruct/, "model: huggingface/Qwen/Qwen3-Next-80B-A3B-Instruct", frontmatter)
            gsub(/model: Qwen\/Qwen2\.5-Coder-7B-Instruct/, "model: huggingface/Qwen/Qwen3-Next-80B-A3B-Thinking", frontmatter)
            gsub(/model: Qwen\/Qwen2\.5-Coder-1\.5B-Instruct/, "model: huggingface/deepseek-ai/DeepSeek-R1-0528", frontmatter)
            
            # Clean up empty lines in frontmatter
            gsub(/\n[[:space:]]*\n/, "\n", frontmatter)
            
            print "---"
            printf "%s", frontmatter
            print "---"
            printf "%s", content
        }
        ' "$agent_file" > "${agent_file}.tmp" && mv "${agent_file}.tmp" "$agent_file"
    fi
done

echo "All agent files have been properly fixed!"