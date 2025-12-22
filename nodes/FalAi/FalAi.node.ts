import type {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

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
		_allSchemas: Record<string, SchemaDefinition>,
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
		inputParameters: parseProperties(inputSchema, schemas),
		outputParameters: parseProperties(outputSchema, schemas),
	};
}

// Cache for model schemas
const modelSchemaCache: Map<string, { data: ParsedModelInfo; timestamp: number }> = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getModelSchema(
	apiKey: string,
	modelId: string,
	httpRequest: ILoadOptionsFunctions['helpers']['httpRequest'],
): Promise<ParsedModelInfo | null> {
	const cached = modelSchemaCache.get(modelId);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
		return cached.data;
	}

	try {
		const response = await httpRequest({
			method: 'GET',
			url: 'https://api.fal.ai/v1/models',
			headers: {
				'Authorization': `Key ${apiKey}`,
			},
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

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout(resolve, ms);
	});
}

export class FalAi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'fal.ai',
		name: 'falAi',
		icon: 'file:falai.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + ($parameter["model"]?.value || $parameter["model"])}}',
		description: 'Generate AI content using fal.ai models',
		defaults: {
			name: 'fal.ai',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'falAiApi',
				required: true,
			},
		],
		properties: [
			// Operation
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
						name: 'Get Usage',
						value: 'getUsage',
						description: 'Get usage statistics (requires Admin API Key)',
						action: 'Get usage statistics',
					},
					{
						name: 'Delete Request Payloads',
						value: 'deletePayloads',
						description: 'Delete request payloads (requires Admin API Key)',
						action: 'Delete request payloads',
					},
				],
				default: 'generate',
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
					},
				},
				options: [
					{
						displayName: 'Parameter',
						name: 'parameters',
						values: [
							{
								displayName: 'Parameter Name',
								name: 'parameter',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getModelParameters',
									loadOptionsDependsOn: ['model'],
								},
								default: '',
								description: 'Select a parameter from the model schema',
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
				required: false,
				displayOptions: {
					show: {
						operation: ['getUsage'],
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
					},
				},
				options: [
					{
						name: 'Last 30 Minutes',
						value: '30m',
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
						name: 'Last 7 Days',
						value: '7d',
					},
					{
						name: 'Last 30 Days',
						value: '30d',
					},
					{
						name: 'Custom Range',
						value: 'custom',
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
						description: 'Maximum number of items to return',
						typeOptions: {
							minValue: 1,
							maxValue: 1000,
						},
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
				const credentials = await this.getCredentials('falAiApi');
				const apiKey = credentials.apiKey as string;

				const qs: Record<string, string> = {
					limit: '50',
				};

				if (filter && filter.trim()) {
					qs.q = filter.trim();
				}

				if (paginationToken) {
					qs.cursor = paginationToken;
				}

				const response = await this.helpers.httpRequest({
					method: 'GET',
					url: 'https://api.fal.ai/v1/models',
					headers: {
						'Authorization': `Key ${apiKey}`,
					},
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
						return [{ name: 'Select a model first', value: '', description: 'Choose a model above to see available parameters' }];
					}

					const credentials = await this.getCredentials('falAiApi');
					const apiKey = credentials.apiKey as string;

					const schema = await getModelSchema(apiKey, modelId, this.helpers.httpRequest.bind(this.helpers));

					if (!schema) {
						return [{ name: 'Could not load parameters', value: '', description: 'Model not found. Verify the model ID is correct.' }];
					}

					if (schema.inputParameters.length === 0) {
						return [{ name: 'No parameters available', value: '', description: 'This model has no configurable parameters' }];
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
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const credentials = await this.getCredentials('falAiApi');
				const apiKey = credentials.apiKey as string;

				let result: IDataObject;

				if (operation === 'getUsage') {
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
					const usageResponse = await this.helpers.httpRequest({
						method: 'GET',
						url: 'https://api.fal.ai/v1/models/usage',
						headers: {
							'Authorization': `Key ${apiKey}`,
						},
						qs,
					}) as IDataObject;

					// Filter out empty time buckets
					let filteredResponse = { ...usageResponse };
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
					const deleteResponse = await this.helpers.httpRequest({
						method: 'DELETE',
						url: `https://api.fal.ai/v1/models/requests/${requestId}/payloads`,
						headers: {
							'Authorization': `Key ${apiKey}`,
						},
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

				} else if (operation === 'getParameters') {
					const model = this.getNodeParameter('model', i, { extractValue: true }) as string;
					const parsedInfo = await getModelSchema(apiKey, model, this.helpers.httpRequest.bind(this.helpers));

					if (!parsedInfo) {
						throw new NodeOperationError(this.getNode(), `Model '${model}' not found. Verify the model ID is correct and the model is available.`);
					}

					result = parsedInfo as unknown as IDataObject;

				} else if (operation === 'generate') {
					const model = this.getNodeParameter('model', i, { extractValue: true }) as string;
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
					const queueResponse = await this.helpers.httpRequest({
						method: 'POST',
						url: `https://queue.fal.run/${model}`,
						headers: {
							'Authorization': `Key ${apiKey}`,
							'Content-Type': 'application/json',
						},
						body: input,
					}) as { request_id: string };

					const requestId = queueResponse.request_id;

					if (!waitForCompletion) {
						result = {
							request_id: requestId,
							model,
							status: 'QUEUED',
							input,
						};
					} else {
						const startTime = Date.now();

						while (Date.now() - startTime < maxWaitTime) {
							const statusResponse = await this.helpers.httpRequest({
								method: 'GET',
								url: `https://queue.fal.run/${model}/requests/${requestId}/status`,
								headers: {
									'Authorization': `Key ${apiKey}`,
								},
							}) as { status: string };

							if (statusResponse.status === 'COMPLETED') {
								const resultResponse = await this.helpers.httpRequest({
									method: 'GET',
									url: `https://queue.fal.run/${model}/requests/${requestId}`,
									headers: {
										'Authorization': `Key ${apiKey}`,
									},
								});

								result = {
									...(resultResponse as IDataObject),
									request_id: requestId,
									model,
								};
								break;
							}

							if (statusResponse.status === 'FAILED') {
								throw new NodeOperationError(this.getNode(), `Generation did not complete successfully. Request ID: ${requestId}. Check the fal.ai dashboard for details.`);
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

				returnData.push({ json: result! });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message } });
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
