# @fal-ai/n8n-nodes-fal

n8n community node for [fal.ai](https://fal.ai) - access hundreds of AI models for image generation, video generation, text-to-speech, and more.

## Installation

### In n8n Desktop/Cloud

1. Go to **Settings** > **Community Nodes**
2. Click **Install a community node**
3. Enter `@fal-ai/n8n-nodes-fal`
4. Click **Install**

### Manual Installation

```bash
cd ~/.n8n/nodes
npm install @fal-ai/n8n-nodes-fal
```

## Configuration

1. Get your API key from [fal.ai Dashboard](https://fal.ai/dashboard/keys)
2. In n8n, go to **Credentials** > **Add Credential** > **fal.ai API**
3. Enter your API key

> **Note:** Some operations (Get Usage, Delete Payloads) require an **Admin API Key**.

## Features

### Model Operations

| Operation | Description |
|-----------|-------------|
| **Generate Media** | Generate images, videos, audio using any fal.ai model |
| **Get Model Info** | Get available parameters and schema for a model |
| **Get Analytics** | Get performance metrics (latency, success rates, error counts) |
| **Get Pricing** | Get pricing information for models |
| **Get Usage** | Get usage statistics (requires Admin API Key) |
| **List Requests** | List requests for a specific endpoint/model |
| **Delete Request Payloads** | Delete request payloads (requires Admin API Key) |

### Workflow Operations

| Operation | Description |
|-----------|-------------|
| **Run Workflow** | Execute a fal.ai workflow with dynamic parameters |
| **List Workflows** | List all your fal.ai workflows |
| **Get Workflow Details** | Get details and schema of a specific workflow |

## Usage Examples

### Generate an Image with Flux

1. Add **fal.ai** node to your workflow
2. Select **Model** resource and **Generate Media** operation
3. Search and select `fal-ai/flux/dev` model
4. Add parameter: `prompt` = "A beautiful sunset over mountains"
5. Execute the node

### Run a Custom Workflow

1. Add **fal.ai** node to your workflow
2. Select **Workflow** resource and **Run Workflow** operation
3. Select your workflow from the dropdown
4. Add workflow-specific parameters
5. Execute the node

### Monitor Model Performance

1. Add **fal.ai** node to your workflow
2. Select **Model** resource and **Get Analytics** operation
3. Select a model (e.g., `fal-ai/flux/dev`)
4. Choose time range and metrics
5. Execute to get performance data

## Supported Models

This node supports all models available on fal.ai, including:

- **Image Generation**: Flux, Stable Diffusion, SDXL, etc.
- **Video Generation**: Kling, Runway, etc.
- **Text-to-Speech**: Various TTS models
- **Speech-to-Text**: Whisper and other STT models
- **Image Editing**: Inpainting, upscaling, style transfer
- **And many more...**

Browse all models at [fal.ai/models](https://fal.ai/models)

## Async Execution

For long-running generations (videos, complex images), the node uses fal.ai's queue system:

- **Wait for Completion**: Enable to wait for the result (default)
- **Poll Interval**: How often to check status (default: 5 seconds)
- **Max Wait Time**: Maximum wait time (default: 10 minutes)

Disable "Wait for Completion" to get the request ID immediately and check status later.

## Links

- [fal.ai Documentation](https://fal.ai/docs)
- [fal.ai Models](https://fal.ai/models)
- [fal.ai Dashboard](https://fal.ai/dashboard)
- [GitHub Repository](https://github.com/fal-ai-community/n8n-nodes-fal)

## License

MIT
