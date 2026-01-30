import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class FalAiApi implements ICredentialType {
	name = 'falAiApi';

	displayName = 'fal.ai API';

	documentationUrl = 'https://fal.ai/docs';

	icon = { light: 'file:../nodes/FalAi/falai.svg', dark: 'file:../nodes/FalAi/falai.svg' } as const;

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
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Key {{$credentials.apiKey}}',
				'User-Agent': 'fal-n8n/1.0.0',
				'X-Fal-Client': 'n8n-nodes-fal-ai',
				'X-Fal-Client-Version': '1.0.0',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.fal.ai',
			url: '/v1/models',
			method: 'GET',
			headers: {
				'User-Agent': 'fal-n8n/1.0.0',
				'X-Fal-Client': 'n8n-nodes-fal-ai',
				'X-Fal-Client-Version': '1.0.0',
			},
			qs: {
				limit: 1,
			},
		},
	};
}
