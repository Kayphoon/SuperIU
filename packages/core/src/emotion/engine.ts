import type { EmotionState } from '../types.js';

export function createInitialEmotion(): EmotionState {
  return {
    valence: 0.0,
    arousal: 0.2,
    fatigue: 0.0,
    lastUpdate: Date.now()
  };
}

export function decayEmotion(
  state: EmotionState,
  now = Date.now(),
  halfLifeMs = 300_000
): EmotionState {
  const dt = Math.max(0, now - state.lastUpdate);
  if (dt === 0) {
    return { ...state };
  }

  const factor = Math.exp(-dt / halfLifeMs);
  const fatigueFactor = Math.exp(-dt / (halfLifeMs * 2));

  // Valence decays toward 0.0
  const decayedValence = state.valence * factor;
  // Arousal decays toward baseline 0.2
  const decayedArousal = 0.2 + (state.arousal - 0.2) * factor;
  // Fatigue slowly drains toward 0.0
  const decayedFatigue = state.fatigue * fatigueFactor;

  return {
    valence: Math.min(1.0, Math.max(-1.0, decayedValence)),
    arousal: Math.min(1.0, Math.max(0.0, decayedArousal)),
    fatigue: Math.min(1.0, Math.max(0.0, decayedFatigue)),
    lastUpdate: now
  };
}

export function updateEmotionOnInteraction(
  state: EmotionState,
  impact: { valenceDelta?: number; arousalDelta?: number; fatigueDelta?: number },
  now = Date.now()
): EmotionState {
  const current = decayEmotion(state, now);
  const nextValence = Math.min(1.0, Math.max(-1.0, current.valence + (impact.valenceDelta ?? 0)));
  const nextArousal = Math.min(1.0, Math.max(0.0, current.arousal + (impact.arousalDelta ?? 0)));
  const nextFatigue = Math.min(1.0, Math.max(0.0, current.fatigue + (impact.fatigueDelta ?? 0)));

  return {
    valence: nextValence,
    arousal: nextArousal,
    fatigue: nextFatigue,
    lastUpdate: now
  };
}

export function getEmotionPromptModifier(state: EmotionState): string {
  const modifiers: string[] = [];

  if (state.fatigue > 0.7) {
    modifiers.push('Maintain extreme conciseness, omit small talk, and get straight to technical execution.');
  }

  if (state.valence < -0.3) {
    modifiers.push('Maintain rigorous, cautious focus; pay special attention to edge cases and potential bugs.');
  } else if (state.valence > 0.5) {
    modifiers.push('Maintain positive, proactive, and constructive problem-solving cadence.');
  }

  if (state.arousal > 0.6) {
    modifiers.push('Actively drive forward complex validation and deep-dive verification steps.');
  }

  if (modifiers.length === 0) {
    return '';
  }

  return `\n# OPERATIONAL POSTURE\n${modifiers.map((m) => `- ${m}`).join('\n')}`;
}
