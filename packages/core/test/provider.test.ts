import { describe, it, expect } from 'vitest';
import {
  resolveProviderType,
  supportsReasoningEffort,
  type ModelRoute
} from '../src/model/router.js';
import { AgentRunner } from '../src/runner.js';

describe('Multi-provider routing and AI SDK integration', () => {
  describe('resolveProviderType', () => {
    it('resolves explicit anthropic provider', () => {
      const route: ModelRoute = { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' };
      expect(resolveProviderType(route)).toBe('anthropic');
    });

    it('resolves explicit google / gemini provider', () => {
      const route1: ModelRoute = { model: 'gemini-2.5-pro', provider: 'google' };
      expect(resolveProviderType(route1)).toBe('google');

      const route2: ModelRoute = { model: 'gemini-2.5-flash', provider: 'gemini' };
      expect(resolveProviderType(route2)).toBe('google');
    });

    it('routes gemini with /openai baseURL to openai compatible provider', () => {
      const route: ModelRoute = {
        model: 'gemini-2.5-flash',
        provider: 'gemini',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/'
      };
      expect(resolveProviderType(route)).toBe('openai');
    });

    it('resolves standard openai-compatible providers to openai', () => {
      expect(resolveProviderType({ model: 'gpt-4o', provider: 'openai' })).toBe('openai');
      expect(resolveProviderType({ model: 'deepseek-flash', provider: 'deepseek' })).toBe('openai');
      expect(resolveProviderType({ model: 'llama3', provider: 'ollama' })).toBe('openai');
      expect(resolveProviderType({ model: 'meta-llama/llama-3', provider: 'openrouter' })).toBe('openai');
    });

    it('auto-detects anthropic by baseURL', () => {
      const route: ModelRoute = {
        model: 'custom-model',
        baseURL: 'https://api.anthropic.com/v1'
      };
      expect(resolveProviderType(route)).toBe('anthropic');
    });

    it('auto-detects anthropic by model id without proxy', () => {
      const route: ModelRoute = {
        model: 'claude-3-7-sonnet-20250219'
      };
      expect(resolveProviderType(route)).toBe('anthropic');
    });

    it('auto-detects google by native generative language baseURL', () => {
      const route: ModelRoute = {
        model: 'custom-model',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta'
      };
      expect(resolveProviderType(route)).toBe('google');
    });
  });

  describe('supportsReasoningEffort for OpenAI-format reasoning models', () => {
    it('does not send reasoning_effort to non-OpenAI-ladder models by default', () => {
      expect(supportsReasoningEffort('claude-3-7-sonnet-20250219')).toBe(false);
      expect(supportsReasoningEffort('gpt-4o')).toBe(false);
    });

    it('recognizes openai, deepseek and gemini reasoning models', () => {
      expect(supportsReasoningEffort('o3-mini')).toBe(true);
      expect(supportsReasoningEffort('gemini-2.5-pro')).toBe(true);
      expect(supportsReasoningEffort('deepseek-flash')).toBe(true);
    });
  });

  describe('AgentRunner.createLanguageModel', () => {
    it('creates Anthropic LanguageModelV1 with anthropic.messages provider', () => {
      const model = AgentRunner.createLanguageModel(
        { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
        { apiKey: 'sk-ant-test' }
      );
      expect(model.provider).toBe('anthropic.messages');
      expect(model.modelId).toBe('claude-3-5-sonnet-20241022');
    });

    it('creates Google LanguageModelV1 with google.generative-ai provider', () => {
      const model = AgentRunner.createLanguageModel(
        { model: 'gemini-2.5-flash', provider: 'google' },
        { apiKey: 'test-google-key' }
      );
      expect(model.provider).toBe('google.generative-ai');
      expect(model.modelId).toBe('gemini-2.5-flash');
    });

    it('creates OpenAI LanguageModelV1 with openai.chat provider', () => {
      const model = AgentRunner.createLanguageModel(
        { model: 'gpt-4o', provider: 'openai' },
        { apiKey: 'sk-openai-test' }
      );
      expect(model.provider).toBe('openai.chat');
      expect(model.modelId).toBe('gpt-4o');
    });
  });
});
