import type {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	JsonObject,
	JsonValue,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

interface FalModelMetadata {
	display_name?: string;
	category?: string;
	description?: string;
	status?: string;
	highlighted?: boolean;
	pinned?: boolean;
}

interface FalModel {
	endpoint_id: string;
	metadata?: FalModelMetadata;
	openapi?: OpenAPISchema;
}

interface FalModelsResponse {
	models: FalModel[];
	next_cursor?: string;
	has_more?: boolean;
}

interface OpenAPISchema {
	info?: {
		title?: string;
		description?: string;
	};
	'x-fal-metadata'?: {
		endpointId?: string;
		category?: string;
		playgroundUrl?: string;
		documentationUrl?: string;
	};
	components?: {
		schemas?: Record<string, SchemaDefinition>;
	};
}

interface SchemaDefinition {
	title?: string;
	type?: string;
	properties?: Record<string, PropertyDefinition>;
	required?: string[];
	'x-fal-order-properties'?: string[];
	items?: PropertyDefinition;
}

interface PropertyDefinition {
	title?: string;
	description?: string;
	type?: string;
	enum?: (string | number)[];
	default?: unknown;
	examples?: unknown[];
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	format?: string;
	allOf?: Array<{ $ref?: string }>;
	items?: PropertyDefinition;
	$ref?: string;
}

interface ParsedParameter {
	name: string;
	type: string;
	title?: string;
	description?: string;
	required: boolean;
	default?: unknown;
	enum?: (string | number)[];
	example?: unknown;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
}

interface ParsedModelInfo {
	model: string;
	displayName?: string;
	category?: string;
	description?: string;
	playgroundUrl?: string;
	documentationUrl?: string;
	inputParameters: ParsedParameter[];
	outputParameters: ParsedParameter[];
}

interface QueueSubmitResponse {
	request_id: string;
	status_url?: string;
	response_url?: string;
	cancel_url?: string;
}

interface QueueStatusResponse {
	status: string;
	response_url?: string;
	status_url?: string;
	cancel_url?: string;
	logs?: unknown[];
	queue_position?: number;
}

interface FalWorkflow {
	id?: string;
	workflow_id?: string;
	name?: string;
	title?: string;
	description?: string;
	owner?: string;
	user_nickname?: string;
	created_at?: string;
	updated_at?: string;
	thumbnail_url?: string;
	tags?: string[];
	endpoint_ids?: string[];
}

interface FalWorkflowsResponse {
	workflows: FalWorkflow[];
}

interface FalUserResponse {
	user_id?: string;
	nickname?: string;
	username?: string;
	name?: string;
}

function parseOpenAPISchema(model: FalModel): ParsedModelInfo {
	const openapi = model.openapi;
	const metadata = model.metadata;
	const falMetadata = openapi?.['x-fal-metadata'];
	const schemas = openapi?.components?.schemas || {};

	let inputSchema: SchemaDefinition | undefined;
	let outputSchema: SchemaDefinition | undefined;

	for (const [name, schema] of Object.entries(schemas)) {
		if (name.endsWith('Input') && !name.includes('Queue')) {
			inputSchema = schema;
		} else if (name.endsWith('Output') && !name.includes('Queue')) {
			outputSchema = schema;
		}
	}

	const parseProperties = (
		schema: SchemaDefinition | undefined,
	): ParsedParameter[] => {
		if (!schema?.properties) return [];

		const required = schema.required || [];
		const orderProps = schema['x-fal-order-properties'] || Object.keys(schema.properties);

		return orderProps
			.filter((propName) => schema.properties![propName])
			.map((propName) => {
				const prop = schema.properties![propName];

				let resolvedType = prop.type || 'string';
				if (prop.allOf && prop.allOf[0]?.$ref) {
					resolvedType = 'string'; // File references become URL strings
				}
				if (prop.type === 'array') {
					resolvedType = 'array';
				}

				return {
					name: propName,
					type: resolvedType,
					title: prop.title,
					description: prop.description,
					required: required.includes(propName),
					default: prop.default,
					enum: prop.enum,
					example: prop.examples?.[0],
					minimum: prop.minimum,
					maximum: prop.maximum,
					minLength: prop.minLength,
					maxLength: prop.maxLength,
				};
			});
	};

	return {
		model: model.endpoint_id,
		displayName: metadata?.display_name,
		category: metadata?.category || falMetadata?.category,
		description: metadata?.description || openapi?.info?.description,
		playgroundUrl: falMetadata?.playgroundUrl,
		documentationUrl: falMetadata?.documentationUrl,
		inputParameters: parseProperties(inputSchema),
		outputParameters: parseProperties(outputSchema),
	};
}

// Cache for model schemas
const modelSchemaCache: Map<string, { data: ParsedModelInfo; timestamp: number }> = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getModelSchema(
	modelId: string,
	httpRequest: (options: IHttpRequestOptions) => Promise<unknown>,
): Promise<ParsedModelInfo | null> {
	const cached = modelSchemaCache.get(modelId);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
		return cached.data;
	}

	try {
		const response = await httpRequest({
			method: 'GET',
			url: 'https://api.fal.ai/v1/models',
			qs: {
				endpoint_id: modelId,
				expand: 'openapi-3.0',
			},
		}) as FalModelsResponse;

		if (!response.models || response.models.length === 0) {
			return null;
		}

		const parsedInfo = parseOpenAPISchema(response.models[0]);
		modelSchemaCache.set(modelId, { data: parsedInfo, timestamp: Date.now() });
		return parsedInfo;
	} catch {
		return null;
	}
}

function resolveQueuePaths(modelId: string): { baseModelId: string; submitPath: string } {
	const parts = modelId.split('/').filter(Boolean);
	if (parts.length <= 2) {
		const normalized = parts.join('/');
		return { baseModelId: normalized, submitPath: normalized };
	}

	const baseModelId = parts.slice(0, 2).join('/');
	const subpath = parts.slice(2).join('/');
	return { baseModelId, submitPath: `${baseModelId}/${subpath}` };
}

function getHttpErrorDetails(error: unknown): { message: string; status?: number; data?: unknown } | null {
	if (!error || typeof error !== 'object') return null;

	const maybeError = error as {
		message?: string;
		response?: {
			status?: number;
			data?: unknown;
		};
	};

	if (!maybeError.response) return null;

	const status = maybeError.response.status;
	const data = maybeError.response.data;
	let message = maybeError.message || 'Request failed';

	if (data) {
		if (typeof data === 'string') {
			message = data;
		} else if (typeof data === 'object') {
			const dataObject = data as Record<string, unknown>;
			const candidate =
				(typeof dataObject.message === 'string' && dataObject.message) ||
				(typeof dataObject.detail === 'string' && dataObject.detail) ||
				(typeof dataObject.error === 'string' && dataObject.error) ||
				(typeof dataObject.title === 'string' && dataObject.title);
			if (candidate) {
				message = candidate;
			}
		}
	}

	return { message, status, data };
}

function toJsonValue(value: unknown): JsonValue | undefined {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(JSON.stringify(value)) as JsonValue;
	} catch {
		return undefined;
	}
}

function buildApiErrorPayload(details: { message: string; status?: number; data?: unknown }): JsonObject {
	const payload: JsonObject = {
		message: details.message,
	};

	if (details.status !== undefined) {
		payload.httpCode = String(details.status);
		payload.statusCode = details.status;
	}

	if (details.data !== undefined) {
		const jsonData = toJsonValue(details.data);
		if (jsonData !== undefined) {
			payload.data = jsonData;
		}
	}

	return payload;
}

export class FalAi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'fal.ai',
		name: 'falAi',
		icon: 'file:falai.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + ($parameter["model"]?.value || $parameter["model"] || $parameter["workflowId"] || "")}}',
		description: 'Generate AI content using fal.ai models and workflows',
		defaults: {
			name: 'fal.ai',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'falAiApi',
				required: true,
			},
		],
		properties: [
			// Resource
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Model',
						value: 'model',
					},
					{
						name: 'Workflow',
						value: 'workflow',
					},
				],
				default: 'model',
			},
			// Operation for Model
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Generate Media',
						value: 'generate',
						description: 'Generate images, videos, audio or other media',
						action: 'Generate media using AI model',
					},
					{
						name: 'Get Model Info',
						value: 'getParameters',
						description: 'Get available parameters and info for a model',
						action: 'Get model parameters and info',
					},
					{
						name: 'Get Analytics',
						value: 'getAnalytics',
						description: 'Get performance analytics (latency, success rates)',
						action: 'Get model analytics',
					},
					{
						name: 'Get Pricing',
						value: 'getPricing',
						description: 'Get pricing information for models',
						action: 'Get model pricing',
					},
					{
						name: 'Get Usage',
						value: 'getUsage',
						description: 'Get usage statistics (requires Admin API Key)',
						action: 'Get usage statistics',
					},
					{
						name: 'List Requests',
						value: 'listRequests',
						description: 'List requests for a specific endpoint/model',
						action: 'List requests by endpoint',
					},
					{
						name: 'Delete Request Payloads',
						value: 'deletePayloads',
						description: 'Delete request payloads (requires Admin API Key)',
						action: 'Delete request payloads',
					},
				],
				default: 'generate',
				displayOptions: {
					show: {
						resource: ['model'],
					},
				},
			},
			// Operation for Workflow
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Run Workflow',
						value: 'runWorkflow',
						description: 'Execute a fal.ai workflow',
						action: 'Run a workflow',
					},
					{
						name: 'List Workflows',
						value: 'listWorkflows',
						description: 'List all your fal.ai workflows',
						action: 'List workflows',
					},
					{
						name: 'Get Workflow Details',
						value: 'getWorkflow',
						description: 'Get details and schema of a specific workflow',
						action: 'Get workflow details',
					},
				],
				default: 'runWorkflow',
				displayOptions: {
					show: {
						resource: ['workflow'],
					},
				},
			},

			// Workflow ID
			{
				displayName: 'Workflow',
				name: 'workflowId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: {
					show: {
						operation: ['runWorkflow', 'getWorkflow'],
						resource: ['workflow'],
					},
				},
				description: 'The fal.ai workflow to use',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						placeholder: 'Search for a workflow...',
						typeOptions: {
							searchListMethod: 'searchWorkflows',
							searchable: true,
							searchFilterRequired: false,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. username/workflow_name',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[a-zA-Z0-9-_]+/[a-zA-Z0-9-_]+$',
									errorMessage: 'Invalid workflow ID format. Use: username/workflow_name',
								},
							},
						],
					},
				],
			},

			// Workflow Parameters - dynamically loaded based on workflow
			{
				displayName: 'Workflow Parameters',
				name: 'workflowParameters',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				placeholder: 'Add Parameter',
				description: 'Add workflow-specific parameters. Click "Add Parameter" and select from available options.',
				displayOptions: {
					show: {
						operation: ['runWorkflow'],
						resource: ['workflow'],
					},
				},
				options: [
					{
						displayName: 'Parameter',
						name: 'parameters',
						values: [
							{
								displayName: 'Parameter Name or ID',
								name: 'parameter',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getWorkflowParameters',
									loadOptionsDependsOn: ['workflowId'],
								},
								default: '',
								description: 'Select a parameter from the workflow schema. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								description: 'Value for the parameter. Use JSON for complex values (arrays, objects).',
							},
						],
					},
				],
			},

			// Workflow Options
			{
				displayName: 'Options',
				name: 'workflowOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						operation: ['runWorkflow'],
						resource: ['workflow'],
					},
				},
				options: [
					{
						displayName: 'Wait for Completion',
						name: 'waitForCompletion',
						type: 'boolean',
						default: true,
						description: 'Whether to wait for the workflow to complete before returning the result',
					},
					{
						displayName: 'Poll Interval (Seconds)',
						name: 'pollInterval',
						type: 'number',
						default: 5,
						description: 'How often to check if workflow is complete',
					},
					{
						displayName: 'Max Wait Time (Seconds)',
						name: 'maxWaitTime',
						type: 'number',
						default: 600,
						description: 'Maximum time to wait for completion (default: 10 minutes)',
					},
				],
			},

			// Request ID for delete operation
			{
				displayName: 'Request ID',
				name: 'requestId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						operation: ['deletePayloads'],
						resource: ['model'],
					},
				},
				description: 'The request ID (UUID) of the request to delete payloads for',
				placeholder: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
			},

			// Model Selection
			{
				displayName: 'Model',
				name: 'model',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: {
					show: {
						operation: ['generate', 'getParameters'],
						resource: ['model'],
					},
				},
				description: 'The fal.ai model to use',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						placeholder: 'Search for a model...',
						typeOptions: {
							searchListMethod: 'searchModels',
							searchable: true,
							searchFilterRequired: false,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. fal-ai/flux/dev',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[a-zA-Z0-9-_./]+$',
									errorMessage: 'Invalid model ID format',
								},
							},
						],
					},
				],
			},

			// Model Parameters - dynamically loaded based on model
			{
				displayName: 'Model Parameters',
				name: 'modelParameters',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				placeholder: 'Add Parameter',
				description: 'Add model-specific parameters. Click "Add Parameter" and select from available options.',
				displayOptions: {
					show: {
						operation: ['generate'],
						resource: ['model'],
					},
				},
				options: [
					{
						displayName: 'Parameter',
						name: 'parameters',
						values: [
							{
								displayName: 'Parameter Name or ID',
								name: 'parameter',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getModelParameters',
									loadOptionsDependsOn: ['model'],
								},
								default: '',
								description: 'Select a parameter from the model schema. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								description: 'Value for the parameter. Use JSON for complex values (arrays, objects).',
							},
						],
					},
				],
			},

			// Model Selection for Get Usage (optional)
			{
				displayName: 'Model',
				name: 'model',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				displayOptions: {
					show: {
						operation: ['getUsage'],
						resource: ['model'],
					},
				},
				description: 'Filter by specific model (optional - leave empty to see all models)',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						placeholder: 'Search for a model...',
						typeOptions: {
							searchListMethod: 'searchModels',
							searchable: true,
							searchFilterRequired: false,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. fal-ai/flux/dev',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[a-zA-Z0-9-_./]+$',
									errorMessage: 'Invalid model ID format',
								},
							},
						],
					},
				],
			},

			// Usage Parameters
			{
				displayName: 'Time Range',
				name: 'timeRange',
				type: 'options',
				displayOptions: {
					show: {
						operation: ['getUsage'],
						resource: ['model'],
					},
				},
				options: [
					{
						name: 'Custom Range',
						value: 'custom',
					},
					{
						name: 'Last 1 Hour',
						value: '1h',
					},
					{
						name: 'Last 24 Hours',
						value: '24h',
					},
					{
						name: 'Last 30 Days',
						value: '30d',
					},
					{
						name: 'Last 30 Minutes',
						value: '30m',
					},
					{
						name: 'Last 7 Days',
						value: '7d',
					},
				],
				default: '24h',
				description: 'Time range for usage data',
			},
			{
				displayName: 'Start Date',
				name: 'startDate',
				type: 'dateTime',
				displayOptions: {
					show: {
						operation: ['getUsage'],
						timeRange: ['custom'],
						resource: ['model'],
					},
				},
				default: '',
				description: 'Start date for custom range (ISO8601 format)',
			},
			{
				displayName: 'End Date',
				name: 'endDate',
				type: 'dateTime',
				displayOptions: {
					show: {
						operation: ['getUsage'],
						timeRange: ['custom'],
						resource: ['model'],
					},
				},
				default: '',
				description: 'End date for custom range (ISO8601 format)',
			},
			{
				displayName: 'Usage Options',
				name: 'usageOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						operation: ['getUsage'],
						resource: ['model'],
					},
				},
				options: [
					{
						displayName: 'Endpoint ID',
						name: 'endpointId',
						type: 'string',
						default: '',
						description: 'Filter by specific endpoint ID (e.g., fal-ai/flux/dev)',
						placeholder: 'fal-ai/flux/dev',
					},
					{
						displayName: 'Include',
						name: 'expand',
						type: 'multiOptions',
						options: [
							{
								name: 'Time Series',
								value: 'time_series',
								description: 'Include time-bucketed usage data',
							},
							{
								name: 'Summary',
								value: 'summary',
								description: 'Include aggregate statistics',
							},
							{
								name: 'Auth Method',
								value: 'auth_method',
								description: 'Include authentication method information',
							},
						],
						default: ['time_series'],
						description: 'What data to include in the response',
					},
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'number',
						default: 50,
						description: 'Max number of results to return',
						typeOptions: {
							minValue: 1,
							maxValue: 1000,
						},
					},
				],
			},

			// Model Selection for List Requests (required)
			{
				displayName: 'Model',
				name: 'model',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: {
					show: {
						operation: ['listRequests'],
						resource: ['model'],
					},
				},
				description: 'The endpoint/model to list requests for',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						placeholder: 'Search for a model...',
						typeOptions: {
							searchListMethod: 'searchModels',
							searchable: true,
							searchFilterRequired: false,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. fal-ai/flux/dev',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[a-zA-Z0-9-_./]+$',
									errorMessage: 'Invalid model ID format',
								},
							},
						],
					},
				],
			},

			// Time Range for List Requests
			{
				displayName: 'Time Range',
				name: 'timeRange',
				type: 'options',
				displayOptions: {
					show: {
						operation: ['listRequests'],
						resource: ['model'],
					},
				},
				options: [
					{
						name: 'Custom Range',
						value: 'custom',
					},
					{
						name: 'Last 1 Hour',
						value: '1h',
					},
					{
						name: 'Last 24 Hours',
						value: '24h',
					},
					{
						name: 'Last 30 Days',
						value: '30d',
					},
					{
						name: 'Last 30 Minutes',
						value: '30m',
					},
					{
						name: 'Last 7 Days',
						value: '7d',
					},
				],
				default: '24h',
				description: 'Time range for listing requests',
			},
			{
				displayName: 'Start Date',
				name: 'startDate',
				type: 'dateTime',
				displayOptions: {
					show: {
						operation: ['listRequests'],
						timeRange: ['custom'],
						resource: ['model'],
					},
				},
				default: '',
				description: 'Start date for custom range (ISO8601 format)',
			},
			{
				displayName: 'End Date',
				name: 'endDate',
				type: 'dateTime',
				displayOptions: {
					show: {
						operation: ['listRequests'],
						timeRange: ['custom'],
						resource: ['model'],
					},
				},
				default: '',
				description: 'End date for custom range (ISO8601 format)',
			},

			// List Requests Options
			{
				displayName: 'Options',
				name: 'listRequestsOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						operation: ['listRequests'],
						resource: ['model'],
					},
				},
				options: [
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						options: [
							{
								name: 'All',
								value: '',
							},
							{
								name: 'Success',
								value: 'success',
							},
							{
								name: 'Error',
								value: 'error',
							},
							{
								name: 'User Error',
								value: 'user_error',
							},
						],
						default: '',
						description: 'Filter by request status',
					},
					{
						displayName: 'Sort By',
						name: 'sortBy',
						type: 'options',
						options: [
							{
								name: 'End Time',
								value: 'ended_at',
							},
							{
								name: 'Duration',
								value: 'duration',
							},
						],
						default: 'ended_at',
						description: 'Sort results by end time or duration',
					},
					{
						displayName: 'Include Payloads',
						name: 'includePayloads',
						type: 'boolean',
						default: false,
						description: 'Whether to include input and output payloads in the response',
					},
					{
						displayName: 'Request ID',
						name: 'requestId',
						type: 'string',
						default: '',
						description: 'Filter by specific request ID (UUID)',
						placeholder: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
					},
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'number',
						default: 50,
						description: 'Number of items to return per page (max 100)',
						typeOptions: {
							minValue: 1,
							maxValue: 100,
						},
					},
				],
			},

			// Model Selection for Analytics (required)
			{
				displayName: 'Model',
				name: 'model',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: {
					show: {
						operation: ['getAnalytics'],
						resource: ['model'],
					},
				},
				description: 'The endpoint/model to get analytics for',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						placeholder: 'Search for a model...',
						typeOptions: {
							searchListMethod: 'searchModels',
							searchable: true,
							searchFilterRequired: false,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. fal-ai/flux/dev',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[a-zA-Z0-9-_./]+$',
									errorMessage: 'Invalid model ID format',
								},
							},
						],
					},
				],
			},

			// Time Range for Analytics
			{
				displayName: 'Time Range',
				name: 'timeRange',
				type: 'options',
				displayOptions: {
					show: {
						operation: ['getAnalytics'],
						resource: ['model'],
					},
				},
				options: [
					{
						name: 'Custom Range',
						value: 'custom',
					},
					{
						name: 'Last 1 Hour',
						value: '1h',
					},
					{
						name: 'Last 24 Hours',
						value: '24h',
					},
					{
						name: 'Last 30 Days',
						value: '30d',
					},
					{
						name: 'Last 30 Minutes',
						value: '30m',
					},
					{
						name: 'Last 7 Days',
						value: '7d',
					},
				],
				default: '24h',
				description: 'Time range for analytics data',
			},
			{
				displayName: 'Start Date',
				name: 'startDate',
				type: 'dateTime',
				displayOptions: {
					show: {
						operation: ['getAnalytics'],
						timeRange: ['custom'],
						resource: ['model'],
					},
				},
				default: '',
				description: 'Start date for custom range (ISO8601 format)',
			},
			{
				displayName: 'End Date',
				name: 'endDate',
				type: 'dateTime',
				displayOptions: {
					show: {
						operation: ['getAnalytics'],
						timeRange: ['custom'],
						resource: ['model'],
					},
				},
				default: '',
				description: 'End date for custom range (ISO8601 format)',
			},

			// Analytics Options
			{
				displayName: 'Options',
				name: 'analyticsOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						operation: ['getAnalytics'],
						resource: ['model'],
					},
				},
				options: [
					{
						displayName: 'Metrics',
						name: 'metrics',
						type: 'multiOptions',
						options: [
							{
								name: 'Request Count',
								value: 'request_count',
								description: 'Total number of requests',
							},
							{
								name: 'Success Count',
								value: 'success_count',
								description: 'Number of successful requests (2xx)',
							},
							{
								name: 'User Error Count',
								value: 'user_error_count',
								description: 'Number of user errors (4xx)',
							},
							{
								name: 'Error Count',
								value: 'error_count',
								description: 'Number of server errors (5xx)',
							},
							{
								name: 'P50 Duration',
								value: 'p50_duration',
								description: '50th percentile execution duration',
							},
							{
								name: 'P75 Duration',
								value: 'p75_duration',
								description: '75th percentile execution duration',
							},
							{
								name: 'P90 Duration',
								value: 'p90_duration',
								description: '90th percentile execution duration',
							},
							{
								name: 'P50 Prepare Duration',
								value: 'p50_prepare_duration',
								description: '50th percentile queue/prepare time',
							},
							{
								name: 'P75 Prepare Duration',
								value: 'p75_prepare_duration',
								description: '75th percentile queue/prepare time',
							},
							{
								name: 'P90 Prepare Duration',
								value: 'p90_prepare_duration',
								description: '90th percentile queue/prepare time',
							},
						],
						default: ['request_count', 'success_count', 'error_count', 'p50_duration', 'p90_duration'],
						description: 'Which metrics to include in the response',
					},
					{
						displayName: 'Include',
						name: 'expand',
						type: 'multiOptions',
						options: [
							{
								name: 'Time Series',
								value: 'time_series',
								description: 'Include time-bucketed analytics data',
							},
							{
								name: 'Summary',
								value: 'summary',
								description: 'Include aggregate statistics for entire range',
							},
						],
						default: ['time_series'],
						description: 'What data to include in the response',
					},
					{
						displayName: 'Timeframe',
						name: 'timeframe',
						type: 'options',
						options: [
							{
								name: 'Auto-Detect',
								value: '',
								description: 'Automatically detect based on date range',
							},
							{
								name: 'Minute',
								value: 'minute',
								description: 'Group by minute (for ranges < 2 hours)',
							},
							{
								name: 'Hour',
								value: 'hour',
								description: 'Group by hour (for ranges < 2 days)',
							},
							{
								name: 'Day',
								value: 'day',
								description: 'Group by day (for ranges < 64 days)',
							},
							{
								name: 'Week',
								value: 'week',
								description: 'Group by week (for ranges < 183 days)',
							},
							{
								name: 'Month',
								value: 'month',
								description: 'Group by month (for ranges >= 183 days)',
							},
						],
						default: '',
						description: 'Aggregation timeframe for time series data',
					},
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'number',
						default: 50,
						description: 'Max number of results to return',
						typeOptions: {
							minValue: 1,
							maxValue: 1000,
						},
					},
				],
			},

			// Model Selection for Pricing (required)
			{
				displayName: 'Model',
				name: 'model',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: {
					show: {
						operation: ['getPricing'],
						resource: ['model'],
					},
				},
				description: 'The model to get pricing for',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						placeholder: 'Search for a model...',
						typeOptions: {
							searchListMethod: 'searchModels',
							searchable: true,
							searchFilterRequired: false,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. fal-ai/flux/dev',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[a-zA-Z0-9-_./]+$',
									errorMessage: 'Invalid model ID format',
								},
							},
						],
					},
				],
			},

			// Execution Options
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {
					waitForCompletion: true,
					pollInterval: 5,
					maxWaitTime: 600,
				},
				displayOptions: {
					show: {
						operation: ['generate'],
						resource: ['model'],
					},
				},
				options: [
					{
						displayName: 'Wait for Completion',
						name: 'waitForCompletion',
						type: 'boolean',
						default: true,
						description: 'Whether to wait for the generation to complete before returning the result',
					},
					{
						displayName: 'Poll Interval (Seconds)',
						name: 'pollInterval',
						type: 'number',
						default: 5,
						description: 'How often to check if generation is complete',
					},
					{
						displayName: 'Max Wait Time (Seconds)',
						name: 'maxWaitTime',
						type: 'number',
						default: 600,
						description: 'Maximum time to wait for completion (default: 10 minutes)',
					},
				],
			},
		],
	};

	methods = {
		listSearch: {
			async searchModels(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<{ results: INodePropertyOptions[]; paginationToken?: string }> {
				const qs: Record<string, string> = {
					limit: '50',
				};

				if (filter && filter.trim()) {
					qs.q = filter.trim();
				}

				if (paginationToken) {
					qs.cursor = paginationToken;
				}

				const response = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
					method: 'GET',
					url: 'https://api.fal.ai/v1/models',
					qs,
				}) as FalModelsResponse;

				if (!response.models || response.models.length === 0) {
					return { results: [] };
				}

				const sortedModels = response.models.sort((a, b) => {
					if (a.metadata?.pinned !== b.metadata?.pinned) {
						return a.metadata?.pinned ? -1 : 1;
					}
					if (a.metadata?.highlighted !== b.metadata?.highlighted) {
						return a.metadata?.highlighted ? -1 : 1;
					}
					const aName = a.metadata?.display_name || a.endpoint_id;
					const bName = b.metadata?.display_name || b.endpoint_id;
					return aName.localeCompare(bName);
				});

				const results = sortedModels.map((model) => ({
					name: `${model.metadata?.display_name || model.endpoint_id} [${model.metadata?.category || 'unknown'}]`,
					value: model.endpoint_id,
				}));

				return {
					results,
					paginationToken: response.next_cursor,
				};
			},
			async searchWorkflows(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<{ results: INodePropertyOptions[]; paginationToken?: string }> {
				try {
					// First, get the current user's info to construct workflow IDs
					let username: string | undefined;

					// Try multiple endpoints to get user info
					const userEndpoints = [
						'https://api.fal.ai/v1/users/me',
						'https://api.fal.ai/users/me',
						'https://api.fal.ai/v1/user',
					];

					for (const endpoint of userEndpoints) {
						if (username) break;
						try {
							const userResponse = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
								method: 'GET',
								url: endpoint,
							}) as FalUserResponse & Record<string, unknown>;
							// Try various field names for username
							username = userResponse.user_id || userResponse.nickname || userResponse.username ||
								userResponse.name || (userResponse.id as string | undefined);
						} catch {
							// Try next endpoint
						}
					}

					const response = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
						method: 'GET',
						url: 'https://api.fal.ai/v1/workflows',
					}) as FalWorkflowsResponse & Record<string, unknown>;

					// Handle different response formats
					let workflows: FalWorkflow[] = [];
					if (response.workflows && Array.isArray(response.workflows)) {
						workflows = response.workflows;
					} else if (Array.isArray(response)) {
						workflows = response as unknown as FalWorkflow[];
					}

					if (workflows.length === 0) {
						return { results: [] };
					}

					// Filter by search term if provided
					if (filter && filter.trim()) {
						const searchTerm = filter.trim().toLowerCase();
						workflows = workflows.filter((wf) => {
							const id = (wf.id || wf.workflow_id || wf.name || '').toLowerCase();
							const name = (wf.name || '').toLowerCase();
							const title = (wf.title || '').toLowerCase();
							return id.includes(searchTerm) || name.includes(searchTerm) || title.includes(searchTerm);
						});
					}

					const results: INodePropertyOptions[] = [];

					for (const wf of workflows) {
						// Get the workflow ID - construct from user_nickname/name
						// API returns: { name, title, user_nickname, ... }
						let workflowId: string | undefined;

						if (wf.id && wf.id.includes('/')) {
							// Already a full path
							workflowId = wf.id;
						} else if (wf.workflow_id && wf.workflow_id.includes('/')) {
							workflowId = wf.workflow_id;
						} else if (wf.user_nickname && wf.name) {
							// Construct from user_nickname and name
							workflowId = `${wf.user_nickname}/${wf.name}`;
						} else if (wf.owner && wf.name) {
							workflowId = `${wf.owner}/${wf.name}`;
						} else if (username && wf.name) {
							workflowId = `${username}/${wf.name}`;
						}

						// Skip if no valid workflow ID
						if (!workflowId) {
							continue;
						}

						const displayName = wf.title || wf.name || workflowId;
						const description = wf.description || workflowId;

						results.push({
							name: displayName,
							value: workflowId,
							description: description,
						});
					}

					return { results };
				} catch {
					// Return empty list if API fails (user might not have any workflows)
					return { results: [] };
				}
			},
		},
		loadOptions: {
			async getModelParameters(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					// Get model from resourceLocator - can be object {mode, value} or string
					const modelRaw = this.getCurrentNodeParameter('model') as string | { mode: string; value: string; __rl?: boolean } | undefined;

					let modelId: string | undefined;
					if (typeof modelRaw === 'string') {
						modelId = modelRaw;
					} else if (modelRaw && typeof modelRaw === 'object' && modelRaw.value) {
						modelId = modelRaw.value;
					}

					if (!modelId) {
						return [{ name: 'Select a Model First', value: '', description: 'Choose a model above to see available parameters' }];
					}

					const authedRequest = (options: IHttpRequestOptions) =>
						this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', options);
					const schema = await getModelSchema(modelId, authedRequest);

					if (!schema) {
						return [{ name: 'Could Not Load Parameters', value: '', description: 'Model not found. Verify the model ID is correct.' }];
					}

					if (schema.inputParameters.length === 0) {
						return [{ name: 'No Parameters Available', value: '', description: 'This model has no configurable parameters' }];
					}

					return schema.inputParameters.map((param) => {
						const constraints: string[] = [];
						if (param.required) constraints.push('required');
						if (param.enum) constraints.push(`options: ${param.enum.join(', ')}`);
						if (param.minimum !== undefined) constraints.push(`min: ${param.minimum}`);
						if (param.maximum !== undefined) constraints.push(`max: ${param.maximum}`);
						if (param.default !== undefined) constraints.push(`default: ${param.default}`);

						let typeInfo = param.type;
						if (param.enum) typeInfo = 'select';

						const description = [
							param.description || param.title || '',
							constraints.length > 0 ? `(${constraints.join(', ')})` : '',
						].filter(Boolean).join(' ');

						return {
							name: `${param.title || param.name} [${typeInfo}]${param.required ? ' *' : ''}`,
							value: param.name,
							description: description || `Parameter: ${param.name}`,
						};
					});
				} catch (error) {
					return [{ name: `Failed to load: ${(error as Error).message}`, value: '' }];
				}
			},
			async getWorkflowParameters(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					// Get workflow from resourceLocator
					const workflowRaw = this.getCurrentNodeParameter('workflowId') as string | { mode: string; value: string; __rl?: boolean } | undefined;

					let workflowId: string | undefined;
					if (typeof workflowRaw === 'string') {
						workflowId = workflowRaw;
					} else if (workflowRaw && typeof workflowRaw === 'object' && workflowRaw.value) {
						workflowId = workflowRaw.value;
					}

					if (!workflowId) {
						return [{ name: 'Select a Workflow First', value: '', description: 'Choose a workflow above to see available parameters' }];
					}

					// Fetch workflow details to get schema
					// API returns an array: [{ workflow: { contents: { schema: { input: {...} } } } }]
					const response = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
						method: 'GET',
						url: `https://api.fal.ai/v1/workflows/${workflowId}`,
					}) as unknown;

					// Handle both array and object response formats
					let workflowData: { contents?: { schema?: { input?: Record<string, unknown> } } } | undefined;

					if (Array.isArray(response) && response.length > 0) {
						// API returns array: [{ workflow: {...} }]
						const firstItem = response[0] as { workflow?: typeof workflowData };
						workflowData = firstItem?.workflow;
					} else if (response && typeof response === 'object') {
						// Direct object: { workflow: {...} } or { contents: {...} }
						const respObj = response as { workflow?: typeof workflowData; contents?: { schema?: { input?: Record<string, unknown> } } };
						workflowData = respObj.workflow || respObj;
					}

					const inputSchema = workflowData?.contents?.schema?.input;

					if (!inputSchema || Object.keys(inputSchema).length === 0) {
						return [{ name: 'No Parameters Available', value: '', description: `Workflow "${workflowId}" has no configurable parameters` }];
					}

					const results: INodePropertyOptions[] = [];

					for (const [paramName, paramDef] of Object.entries(inputSchema)) {
						const param = paramDef as {
							name?: string;
							label?: string;
							type?: string | { type?: string; items?: unknown };
							description?: string;
							required?: boolean;
							examples?: unknown[];
							default?: unknown;
						};

						const constraints: string[] = [];
						if (param.required) constraints.push('required');
						if (param.default !== undefined) constraints.push(`default: ${param.default}`);
						if (param.examples && param.examples.length > 0) {
							const exampleStr = typeof param.examples[0] === 'string'
								? param.examples[0]
								: JSON.stringify(param.examples[0]);
							constraints.push(`example: ${exampleStr.substring(0, 50)}${exampleStr.length > 50 ? '...' : ''}`);
						}

						// Handle complex type definitions
						let typeInfo = 'string';
						if (typeof param.type === 'string') {
							typeInfo = param.type;
						} else if (param.type && typeof param.type === 'object') {
							// Complex type like { type: "array", items: {...} }
							const typeObj = param.type as { type?: string; items?: { type?: string } };
							if (typeObj.type === 'array') {
								const itemType = typeObj.items?.type || 'any';
								typeInfo = `array<${itemType}>`;
							} else if (typeObj.type) {
								typeInfo = typeObj.type;
							} else {
								typeInfo = 'object';
							}
						}

						const description = [
							param.description || param.label || '',
							constraints.length > 0 ? `(${constraints.join(', ')})` : '',
						].filter(Boolean).join(' ');

						results.push({
							name: `${param.label || param.name || paramName} [${typeInfo}]${param.required ? ' *' : ''}`,
							value: paramName,
							description: description || `Parameter: ${paramName}`,
						});
					}

					return results;
				} catch (error) {
					const errMsg = (error as Error).message || 'Unknown error';
					return [{ name: `Failed to load parameters`, value: '', description: errMsg }];
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i, 'model') as string;
				const operation = this.getNodeParameter('operation', i) as string;

				let result: IDataObject;

				if (resource === 'model') {
					if (operation === 'getAnalytics') {
						const modelRaw = this.getNodeParameter('model', i) as string | { mode: string; value: string };
						const timeRange = this.getNodeParameter('timeRange', i) as string;
						const analyticsOptions = this.getNodeParameter('analyticsOptions', i, {}) as IDataObject;

						// Extract model/endpoint_id value
						let endpointId: string;
						if (typeof modelRaw === 'string') {
							endpointId = modelRaw;
						} else if (modelRaw && typeof modelRaw === 'object' && modelRaw.value) {
							endpointId = modelRaw.value;
						} else {
							throw new NodeOperationError(this.getNode(), 'Model/Endpoint ID is required for Analytics operation');
						}

						// Calculate start and end dates
						let startDate: string;
						let endDate: string = new Date().toISOString();

						if (timeRange === 'custom') {
							startDate = this.getNodeParameter('startDate', i) as string;
							endDate = this.getNodeParameter('endDate', i) as string;
						} else {
							const now = new Date();
							const start = new Date();

							switch (timeRange) {
								case '30m':
									start.setMinutes(now.getMinutes() - 30);
									break;
								case '1h':
									start.setHours(now.getHours() - 1);
									break;
								case '24h':
									start.setHours(now.getHours() - 24);
									break;
								case '7d':
									start.setDate(now.getDate() - 7);
									break;
								case '30d':
									start.setDate(now.getDate() - 30);
									break;
							}
							startDate = start.toISOString();
						}

						// Build expand array with time_series/summary and metrics
						const expandItems: string[] = [];

						// Add time_series or summary
						if (analyticsOptions.expand && Array.isArray(analyticsOptions.expand)) {
							expandItems.push(...(analyticsOptions.expand as string[]));
						} else {
							expandItems.push('time_series'); // Default
						}

						// Add metrics
						if (analyticsOptions.metrics && Array.isArray(analyticsOptions.metrics)) {
							expandItems.push(...(analyticsOptions.metrics as string[]));
						} else {
							// Default metrics
							expandItems.push('request_count', 'success_count', 'error_count', 'p50_duration', 'p90_duration');
						}

						// Build query parameters
						const qs: IDataObject = {
							endpoint_id: endpointId,
							start: startDate,
							end: endDate,
							expand: expandItems.join(','),
						};

						// Add optional timeframe
						if (analyticsOptions.timeframe && analyticsOptions.timeframe !== '') {
							qs.timeframe = analyticsOptions.timeframe;
						}

						if (analyticsOptions.limit) {
							qs.limit = analyticsOptions.limit;
						}

						// Get analytics data
						const analyticsResponse = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
							method: 'GET',
							url: 'https://api.fal.ai/v1/models/analytics',
							qs,
						}) as IDataObject;

						result = {
							endpoint_id: endpointId,
							time_range: {
								start: startDate,
								end: endDate,
								range: timeRange,
							},
							...analyticsResponse,
						};

					} else if (operation === 'getPricing') {
						const modelRaw = this.getNodeParameter('model', i) as string | { mode: string; value: string };

						// Extract model/endpoint_id value
						let endpointId: string;
						if (typeof modelRaw === 'string') {
							endpointId = modelRaw;
						} else if (modelRaw && typeof modelRaw === 'object' && modelRaw.value) {
							endpointId = modelRaw.value;
						} else {
							throw new NodeOperationError(this.getNode(), 'Model/Endpoint ID is required for Pricing operation');
						}

						// Get pricing data
						const pricingResponse = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
							method: 'GET',
							url: 'https://api.fal.ai/v1/models/pricing',
							qs: {
								endpoint_id: endpointId,
							},
						}) as IDataObject;

						// Extract the pricing info for the requested model
						const prices = pricingResponse.prices as Array<{
							endpoint_id: string;
							unit_price: number;
							unit: string;
							currency: string;
						}>;

						const modelPricing = prices?.find(p => p.endpoint_id === endpointId);

						result = {
							endpoint_id: endpointId,
							pricing: modelPricing || null,
							...pricingResponse,
						};

					} else if (operation === 'getUsage') {
						const timeRange = this.getNodeParameter('timeRange', i) as string;
						const usageOptions = this.getNodeParameter('usageOptions', i, {}) as IDataObject;
						const modelRaw = this.getNodeParameter('model', i, '') as string | { mode: string; value: string };

						// Extract model value if it exists
						let model: string | undefined;
						if (typeof modelRaw === 'string') {
							model = modelRaw;
						} else if (modelRaw && typeof modelRaw === 'object' && modelRaw.value) {
							model = modelRaw.value;
						}

						// Calculate start and end dates
						let startDate: string;
						let endDate: string = new Date().toISOString();

						if (timeRange === 'custom') {
							startDate = this.getNodeParameter('startDate', i) as string;
							endDate = this.getNodeParameter('endDate', i) as string;
						} else {
							const now = new Date();
							const start = new Date();

							switch (timeRange) {
								case '30m':
									start.setMinutes(now.getMinutes() - 30);
									break;
								case '1h':
									start.setHours(now.getHours() - 1);
									break;
								case '24h':
									start.setHours(now.getHours() - 24);
									break;
								case '7d':
									start.setDate(now.getDate() - 7);
									break;
								case '30d':
									start.setDate(now.getDate() - 30);
									break;
							}
							startDate = start.toISOString();
						}

						// Build query parameters
						const qs: IDataObject = {
							start: startDate,
							end: endDate,
						};

						// Use selected model as endpoint_id, or use manual override from options
						if (usageOptions.endpointId) {
							qs.endpoint_id = usageOptions.endpointId;
						} else if (model) {
							qs.endpoint_id = model;
						}

						if (usageOptions.expand && Array.isArray(usageOptions.expand)) {
							qs.expand = usageOptions.expand.join(',');
						}

						if (usageOptions.limit) {
							qs.limit = usageOptions.limit;
						}

						// Get usage data
						const usageResponse = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
							method: 'GET',
							url: 'https://api.fal.ai/v1/models/usage',
							qs,
						}) as IDataObject;

						// Filter out empty time buckets
						const filteredResponse = { ...usageResponse };
						if (usageResponse.time_series && Array.isArray(usageResponse.time_series)) {
							filteredResponse.time_series = usageResponse.time_series.filter((bucket: IDataObject) => {
								return bucket.results && Array.isArray(bucket.results) && bucket.results.length > 0;
							});
						}

						// Check if we have any data
						const hasData = filteredResponse.time_series &&
							Array.isArray(filteredResponse.time_series) &&
							filteredResponse.time_series.length > 0;

						result = {
							time_range: {
								start: startDate,
								end: endDate,
								range: timeRange,
							},
							...filteredResponse,
							// Add helpful metadata
							_meta: {
								has_usage_data: hasData,
								filtered_model: model || usageOptions.endpointId || 'all',
								message: !hasData && (model || usageOptions.endpointId)
									? `No usage data found for model "${model || usageOptions.endpointId}" in the selected time range`
									: hasData
										? 'Usage data retrieved successfully'
										: 'No usage data found in the selected time range',
							},
						};

					} else if (operation === 'deletePayloads') {
						const requestId = this.getNodeParameter('requestId', i) as string;

						// Delete request payloads
						const deleteResponse = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
							method: 'DELETE',
							url: `https://api.fal.ai/v1/models/requests/${requestId}/payloads`,
						}) as { cdn_delete_results: Array<{ link: string; exception: string | null }> };

						result = {
							request_id: requestId,
							deleted: true,
							cdn_delete_results: deleteResponse.cdn_delete_results,
							summary: {
								total_files: deleteResponse.cdn_delete_results.length,
								successful: deleteResponse.cdn_delete_results.filter(r => r.exception === null).length,
								failed: deleteResponse.cdn_delete_results.filter(r => r.exception !== null).length,
							},
						};

					} else if (operation === 'listRequests') {
						const modelRaw = this.getNodeParameter('model', i) as string | { mode: string; value: string };
						const timeRange = this.getNodeParameter('timeRange', i) as string;
						const listRequestsOptions = this.getNodeParameter('listRequestsOptions', i, {}) as IDataObject;

						// Extract model/endpoint_id value
						let endpointId: string;
						if (typeof modelRaw === 'string') {
							endpointId = modelRaw;
						} else if (modelRaw && typeof modelRaw === 'object' && modelRaw.value) {
							endpointId = modelRaw.value;
						} else {
							throw new NodeOperationError(this.getNode(), 'Model/Endpoint ID is required for List Requests operation');
						}

						// Calculate start and end dates
						let startDate: string;
						let endDate: string = new Date().toISOString();

						if (timeRange === 'custom') {
							startDate = this.getNodeParameter('startDate', i) as string;
							endDate = this.getNodeParameter('endDate', i) as string;
						} else {
							const now = new Date();
							const start = new Date();

							switch (timeRange) {
								case '30m':
									start.setMinutes(now.getMinutes() - 30);
									break;
								case '1h':
									start.setHours(now.getHours() - 1);
									break;
								case '24h':
									start.setHours(now.getHours() - 24);
									break;
								case '7d':
									start.setDate(now.getDate() - 7);
									break;
								case '30d':
									start.setDate(now.getDate() - 30);
									break;
							}
							startDate = start.toISOString();
						}

						// Build query parameters
						const qs: IDataObject = {
							endpoint_id: endpointId,
							start: startDate,
							end: endDate,
						};

						// Add optional filters
						if (listRequestsOptions.status && listRequestsOptions.status !== '') {
							qs.status = listRequestsOptions.status;
						}

						if (listRequestsOptions.sortBy) {
							qs.sort_by = listRequestsOptions.sortBy;
						}

						if (listRequestsOptions.includePayloads) {
							qs.expand = 'payloads';
						}

						if (listRequestsOptions.requestId && listRequestsOptions.requestId !== '') {
							qs.request_id = listRequestsOptions.requestId;
						}

						if (listRequestsOptions.limit) {
							qs.limit = listRequestsOptions.limit;
						}

						// Get requests data
						const requestsResponse = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
							method: 'GET',
							url: 'https://api.fal.ai/v1/models/requests/by-endpoint',
							qs,
						}) as IDataObject;

						result = {
							endpoint_id: endpointId,
							time_range: {
								start: startDate,
								end: endDate,
								range: timeRange,
							},
							...requestsResponse,
						};

					} else if (operation === 'getParameters') {
						const model = this.getNodeParameter('model', i, '', { extractValue: true }) as string;
						const authedRequest = (options: IHttpRequestOptions) =>
							this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', options);
						const parsedInfo = await getModelSchema(model, authedRequest);

						if (!parsedInfo) {
							throw new NodeOperationError(this.getNode(), `Model '${model}' not found. Verify the model ID is correct and the model is available.`);
						}

						result = parsedInfo as unknown as IDataObject;

					} else if (operation === 'generate') {
						const model = this.getNodeParameter('model', i, '', { extractValue: true }) as string;
						const { baseModelId, submitPath } = resolveQueuePaths(model);
						// Build input from model parameters
						const input: IDataObject = {};

						// Get dynamic model parameters
						const modelParameters = this.getNodeParameter('modelParameters', i, {}) as {
							parameters?: Array<{ parameter: string; value: string }>;
						};

						if (modelParameters.parameters && modelParameters.parameters.length > 0) {
							for (const param of modelParameters.parameters) {
								if (param.parameter && param.value !== undefined && param.value !== '') {
									// Try to parse as JSON for complex values
									let parsedValue: unknown = param.value;
									try {
										// Check if it looks like JSON
										const trimmed = param.value.trim();
										if (
											(trimmed.startsWith('{') && trimmed.endsWith('}')) ||
											(trimmed.startsWith('[') && trimmed.endsWith(']')) ||
											trimmed === 'true' ||
											trimmed === 'false' ||
											!isNaN(Number(trimmed))
										) {
											parsedValue = JSON.parse(trimmed);
										}
									} catch {
										// Keep as string if JSON parse fails
									}
									input[param.parameter] = parsedValue as IDataObject[keyof IDataObject];
								}
							}
						}

						// Get execution options
						const options = this.getNodeParameter('options', i, {}) as IDataObject;
						const waitForCompletion = options.waitForCompletion !== false;
						const pollInterval = ((options.pollInterval as number) || 5) * 1000;
						const maxWaitTime = ((options.maxWaitTime as number) || 600) * 1000;

						// Submit to queue
						const queueResponse = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
							method: 'POST',
							url: `https://queue.fal.run/${submitPath}`,
							headers: { 'Content-Type': 'application/json' },
							body: input,
						}) as QueueSubmitResponse;

						const requestId = queueResponse.request_id;
						const statusUrl = queueResponse.status_url || `https://queue.fal.run/${baseModelId}/requests/${requestId}/status`;
						const responseUrl = queueResponse.response_url || `https://queue.fal.run/${baseModelId}/requests/${requestId}`;
						const cancelUrl = queueResponse.cancel_url || `https://queue.fal.run/${baseModelId}/requests/${requestId}/cancel`;

						if (!waitForCompletion) {
							result = {
								request_id: requestId,
								model,
								status: 'QUEUED',
								input,
								status_url: statusUrl,
								response_url: responseUrl,
								cancel_url: cancelUrl,
							};
						} else {
							const startTime = Date.now();

							while (Date.now() - startTime < maxWaitTime) {
								const statusResponse = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
									method: 'GET',
									url: statusUrl,
								}) as QueueStatusResponse;

								if (statusResponse.status === 'COMPLETED') {
									const resolvedResponseUrl = statusResponse.response_url || responseUrl;
									const resultResponse = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
										method: 'GET',
										url: resolvedResponseUrl,
									});

									result = {
										...(resultResponse as IDataObject),
										request_id: requestId,
										model,
									};
									break;
								}

								if (statusResponse.status === 'FAILED' || statusResponse.status === 'CANCELLED') {
									throw new NodeOperationError(
										this.getNode(),
										`Generation did not complete successfully (status: ${statusResponse.status}). Request ID: ${requestId}. Check the fal.ai dashboard for details.`,
										{ itemIndex: i },
									);
								}

								if (statusResponse.status !== 'IN_QUEUE' && statusResponse.status !== 'IN_PROGRESS') {
									throw new NodeOperationError(
										this.getNode(),
										`Unexpected queue status "${statusResponse.status}". Request ID: ${requestId}.`,
										{ itemIndex: i },
									);
								}

								await sleep(pollInterval);
							}

							if (!result!) {
								throw new NodeOperationError(
									this.getNode(),
									`Generation timed out after ${maxWaitTime / 1000} seconds. Request ID: ${requestId}. Increase 'Max Wait Time' or disable 'Wait for Completion' to get the request ID immediately.`,
								);
							}
						}
					} else {
						throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
					}
				} else if (resource === 'workflow') {
					if (operation === 'runWorkflow') {
						const workflowId = this.getNodeParameter('workflowId', i, '', { extractValue: true }) as string;
						const workflowOptions = this.getNodeParameter('workflowOptions', i, {}) as IDataObject;

						if (!workflowId || !workflowId.includes('/')) {
							throw new NodeOperationError(
								this.getNode(),
								'Invalid workflow ID format. Use: username/workflow_name (e.g., ilker-bgptjoq213qo/r3)',
							);
						}

						// Build input from workflow parameters
						const input: IDataObject = {};

						// Get dynamic workflow parameters
						const workflowParameters = this.getNodeParameter('workflowParameters', i, {}) as {
							parameters?: Array<{ parameter: string; value: string }>;
						};

						if (workflowParameters.parameters && workflowParameters.parameters.length > 0) {
							for (const param of workflowParameters.parameters) {
								if (param.parameter && param.value !== undefined && param.value !== '') {
									// Try to parse as JSON for complex values
									let parsedValue: unknown = param.value;
									try {
										// Check if it looks like JSON
										const trimmed = param.value.trim();
										if (
											(trimmed.startsWith('{') && trimmed.endsWith('}')) ||
											(trimmed.startsWith('[') && trimmed.endsWith(']')) ||
											trimmed === 'true' ||
											trimmed === 'false' ||
											!isNaN(Number(trimmed))
										) {
											parsedValue = JSON.parse(trimmed);
										}
									} catch {
										// Keep as string if JSON parse fails
									}
									input[param.parameter] = parsedValue as IDataObject[keyof IDataObject];
								}
							}
						}

						const waitForCompletion = workflowOptions.waitForCompletion !== false;
						const pollInterval = ((workflowOptions.pollInterval as number) || 5) * 1000;
						const maxWaitTime = ((workflowOptions.maxWaitTime as number) || 600) * 1000;

						// Submit to queue - workflow endpoint format: workflows/username/workflow_name
						const queueResponseRaw = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
							method: 'POST',
							url: `https://queue.fal.run/workflows/${workflowId}`,
							headers: { 'Content-Type': 'application/json' },
							body: input,
						});
						const queueResponse = queueResponseRaw as QueueSubmitResponse;

						const requestId = queueResponse.request_id;
						const statusUrl = queueResponse.status_url || `https://queue.fal.run/workflows/${workflowId}/requests/${requestId}/status`;
						const responseUrl = queueResponse.response_url || `https://queue.fal.run/workflows/${workflowId}/requests/${requestId}`;
						const cancelUrl = queueResponse.cancel_url || `https://queue.fal.run/workflows/${workflowId}/requests/${requestId}/cancel`;

						if (!waitForCompletion) {
							result = {
								request_id: requestId,
								workflow_id: workflowId,
								status: 'QUEUED',
								status_url: statusUrl,
								response_url: responseUrl,
								cancel_url: cancelUrl,
								input,
							};
						} else {
							const startTime = Date.now();

							while (Date.now() - startTime < maxWaitTime) {
								const statusResponseRaw = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
									method: 'GET',
									url: statusUrl,
								});
								const statusResponse = statusResponseRaw as QueueStatusResponse;

								if (statusResponse.status === 'COMPLETED') {
									const resolvedResponseUrl = statusResponse.response_url || responseUrl;
									const resultResponse = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
										method: 'GET',
										url: resolvedResponseUrl,
									});

									result = {
										...(resultResponse as IDataObject),
										request_id: requestId,
										workflow_id: workflowId,
									};
									break;
								}

								if (statusResponse.status === 'FAILED' || statusResponse.status === 'CANCELLED') {
									throw new NodeOperationError(
										this.getNode(),
										`Workflow execution failed (status: ${statusResponse.status}). Request ID: ${requestId}. Check the fal.ai dashboard for details.`,
										{ itemIndex: i },
									);
								}

								if (statusResponse.status !== 'IN_QUEUE' && statusResponse.status !== 'IN_PROGRESS') {
									throw new NodeOperationError(
										this.getNode(),
										`Unexpected workflow status "${statusResponse.status}". Request ID: ${requestId}.`,
										{ itemIndex: i },
									);
								}

								await sleep(pollInterval);
							}

							if (!result!) {
								throw new NodeOperationError(
									this.getNode(),
									`Workflow timed out after ${maxWaitTime / 1000} seconds. Request ID: ${requestId}. Increase 'Max Wait Time' or disable 'Wait for Completion'.`,
								);
							}
						}

					} else if (operation === 'listWorkflows') {
						result = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
							method: 'GET',
							url: 'https://api.fal.ai/v1/workflows',
						}) as IDataObject;

					} else if (operation === 'getWorkflow') {
						const workflowId = this.getNodeParameter('workflowId', i, '', { extractValue: true }) as string;

						if (!workflowId || !workflowId.includes('/')) {
							throw new NodeOperationError(
								this.getNode(),
								'Invalid workflow ID format. Use: username/workflow_name (e.g., pixelz/upscaler)',
							);
						}

						result = await this.helpers.httpRequestWithAuthentication.call(this, 'falAiApi', {
							method: 'GET',
							url: `https://api.fal.ai/v1/workflows/${workflowId}`,
						}) as IDataObject;

					} else {
						throw new NodeOperationError(this.getNode(), `Unknown workflow operation: ${operation}`);
					}
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown resource: ${resource}`);
				}

				returnData.push({ json: result!, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				const httpDetails = getHttpErrorDetails(error);
				if (httpDetails) {
					const safePayload = buildApiErrorPayload(httpDetails);
					const message = `fal.ai request failed${httpDetails.status ? ` (${httpDetails.status})` : ''}: ${httpDetails.message}`;
					throw new NodeApiError(this.getNode(), safePayload, { message, itemIndex: i });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
