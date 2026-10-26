import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
	Icon,
} from 'n8n-workflow';

export class FalAiApi implements ICredentialType {
	name = 'falAiApi';

	displayName = 'fal.ai API';

	documentationUrl = 'https://fal.ai/docs';

	icon: Icon = 'file:../icons/falai.svg';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Your fal.ai API key from https://fal.ai/dashboard/keys. Note: Admin API Key required for Get Usage and Delete Payloads operations.',
			hint: 'Use an Admin API Key to access usage statistics and delete operations',
		},
		{
			displayName: 'API Base URL',
			name: 'apiBaseUrl',
			type: 'hidden',
			default: 'https://api.fal.ai',
		},
		{
			displayName: 'Queue Base URL',
			name: 'queueBaseUrl',
			type: 'hidden',
			default: 'https://queue.fal.run',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Key {{$credentials?.apiKey}}',
				'User-Agent': 'n8n-nodes-fal/1.0.1',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.apiBaseUrl}}',
			url: '/v1/models',
			method: 'GET',
			qs: {
				limit: 1,
			},
		},
	};
}
