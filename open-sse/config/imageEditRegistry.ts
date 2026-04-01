/**
 * Image Edit Registry
 *
 * OmniRoute is the single source of truth for edit-capable providers, models,
 * and fallback order. MCP callers keep their provider-shaped tool names, while
 * the actual routing policy lives here.
 */

export interface ImageEditModel {
  id: string;
  name: string;
}

export interface ImageEditProviderConfig {
  id: string;
  authType: "apikey" | "oauth" | "none";
  authHeader: "bearer" | "none";
  format: "dashscope-image-edit" | "fireworks-workflow-edit" | "chutes-image-edit";
  models: ImageEditModel[];
}

export interface ImageEditRouteCandidate {
  provider: string;
  model: string;
  fullId: string;
  family: "dashscope_edit" | "fireworks_edit" | "chutes_edit";
  priority: number;
  isFallback: boolean;
}

const CHUTES_FALLBACK_ROUTE: ImageEditRouteCandidate = {
  provider: "chutes",
  model: "qwen-image-edit-2509",
  fullId: "chutes/qwen-image-edit-2509",
  family: "chutes_edit",
  priority: 100,
  isFallback: true,
};

export const IMAGE_EDIT_PROVIDERS: Record<string, ImageEditProviderConfig> = {
  dashscope: {
    id: "dashscope",
    authType: "apikey",
    authHeader: "bearer",
    format: "dashscope-image-edit",
    models: [
      { id: "qwen-image-2.0", name: "Qwen Image 2.0 Edit" },
      { id: "qwen-image-2.0-pro", name: "Qwen Image 2.0 Pro Edit" },
    ],
  },
  fireworks: {
    id: "fireworks",
    authType: "apikey",
    authHeader: "bearer",
    format: "fireworks-workflow-edit",
    models: [
      { id: "flux-kontext-pro", name: "FLUX Kontext Pro Edit" },
      { id: "flux-kontext-max", name: "FLUX Kontext Max Edit" },
    ],
  },
  chutes: {
    id: "chutes",
    authType: "apikey",
    authHeader: "bearer",
    format: "chutes-image-edit",
    models: [{ id: "qwen-image-edit-2509", name: "Qwen Image Edit 2509" }],
  },
};

function findProviderByBareModel(modelStr: string): string | null {
  for (const [providerId, config] of Object.entries(IMAGE_EDIT_PROVIDERS)) {
    if (config.models.some((model) => model.id === modelStr)) {
      return providerId;
    }
  }

  return null;
}

export function getImageEditProvider(providerId: string): ImageEditProviderConfig | null {
  return IMAGE_EDIT_PROVIDERS[providerId] || null;
}

export function parseImageEditModel(modelStr: string | null | undefined) {
  if (!modelStr) {
    return { provider: null, model: null };
  }

  const trimmed = modelStr.trim();
  for (const providerId of Object.keys(IMAGE_EDIT_PROVIDERS)) {
    if (trimmed.startsWith(`${providerId}/`)) {
      return {
        provider: providerId,
        model: trimmed.slice(providerId.length + 1),
      };
    }
  }

  const provider = findProviderByBareModel(trimmed);
  return {
    provider,
    model: trimmed,
  };
}

function makeRoute(
  provider: string,
  model: string,
  family: ImageEditRouteCandidate["family"],
  priority: number,
  isFallback: boolean
): ImageEditRouteCandidate {
  return {
    provider,
    model,
    fullId: `${provider}/${model}`,
    family,
    priority,
    isFallback,
  };
}

function resolveDashscopePlan(model: string | null): ImageEditRouteCandidate[] {
  const resolvedModel =
    model && IMAGE_EDIT_PROVIDERS.dashscope.models.some((entry) => entry.id === model)
      ? model
      : "qwen-image-2.0";

  return [
    makeRoute("dashscope", resolvedModel, "dashscope_edit", 10, false),
    CHUTES_FALLBACK_ROUTE,
  ];
}

function resolveFireworksPlan(model: string | null): ImageEditRouteCandidate[] {
  const resolvedModel =
    model && IMAGE_EDIT_PROVIDERS.fireworks.models.some((entry) => entry.id === model)
      ? model
      : "flux-kontext-pro";

  return [
    makeRoute("fireworks", resolvedModel, "fireworks_edit", 10, false),
    CHUTES_FALLBACK_ROUTE,
  ];
}

function resolveChutesPlan(): ImageEditRouteCandidate[] {
  return [makeRoute("chutes", "qwen-image-edit-2509", "chutes_edit", 10, false)];
}

export function resolveImageEditRoutes(
  modelStr: string | null | undefined
): ImageEditRouteCandidate[] {
  const parsed = parseImageEditModel(modelStr);

  if (parsed.provider === "dashscope") {
    return resolveDashscopePlan(parsed.model);
  }

  if (parsed.provider === "fireworks") {
    return resolveFireworksPlan(parsed.model);
  }

  if (parsed.provider === "chutes") {
    return resolveChutesPlan();
  }

  if (parsed.model === "qwen-image-2.0" || parsed.model === "qwen-image-2.0-pro") {
    return resolveDashscopePlan(parsed.model);
  }

  if (parsed.model === "flux-kontext-pro" || parsed.model === "flux-kontext-max") {
    return resolveFireworksPlan(parsed.model);
  }

  if (parsed.model === "qwen-image-edit-2509") {
    return resolveChutesPlan();
  }

  return [];
}

export function getAllImageEditModels() {
  return [
    ...IMAGE_EDIT_PROVIDERS.dashscope.models.map((model) => ({
      id: `dashscope/${model.id}`,
      name: model.name,
      provider: "dashscope",
      family: "dashscope_edit",
      priority: 10,
      isFallback: false,
    })),
    ...IMAGE_EDIT_PROVIDERS.fireworks.models.map((model) => ({
      id: `fireworks/${model.id}`,
      name: model.name,
      provider: "fireworks",
      family: "fireworks_edit",
      priority: 10,
      isFallback: false,
    })),
    {
      id: CHUTES_FALLBACK_ROUTE.fullId,
      name: "Qwen Image Edit 2509",
      provider: "chutes",
      family: "chutes_edit",
      priority: CHUTES_FALLBACK_ROUTE.priority,
      isFallback: false,
    },
  ];
}
