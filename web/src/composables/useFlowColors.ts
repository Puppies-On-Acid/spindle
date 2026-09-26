import { ref, watch, type Ref } from "vue";
import { coverUrl } from "@/api/client";
import type { FlowData } from "@/api/types";
import { paletteFromImage, rgbToOklch, type ImageDataLike } from "@/lib/accent";
import { fallbackFlowColor, hueDistance, oklchHue } from "@/lib/flow";

const OTHER_COLOR = "oklch(0.48 0.025 250)";
const SAMPLE = 32;
const MIN_CHROMATIC_PIXELS = 10;
const LOAD_TIMEOUT_MS = 8000;
const CACHE_LIMIT = 200;

const palettes = new Map<string, Promise<string[] | null>>();

function isChromatic(pixels: ImageDataLike): boolean {
  let count = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const { l, c } = rgbToOklch(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]);
    if (c >= 0.03 && l >= 0.12 && l <= 0.95 && ++count >= MIN_CHROMATIC_PIXELS) return true;
  }
  return false;
}

function readPalette(image: HTMLImageElement): string[] | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
  const pixels = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
  return isChromatic(pixels) ? paletteFromImage(pixels, 3) : null;
}

function coverPalette(id: string): Promise<string[] | null> {
  const cached = palettes.get(id);
  if (cached) return cached;
  const promise = new Promise<string[] | null>((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
    const done = (palette: string[] | null) => { clearTimeout(timer); resolve(palette); };
    image.onload = () => {
      try { done(readPalette(image)); } catch { done(null); }
    };
    image.onerror = () => done(null);
    image.src = coverUrl(id, 64);
  });
  if (palettes.size > CACHE_LIMIT) palettes.clear();
  palettes.set(id, promise);
  return promise;
}

function mostDistinct(candidates: string[], used: number[]): string {
  if (!used.length) return candidates[0];
  const distance = (c: string) => Math.min(...used.map((h) => hueDistance(h, oklchHue(c))));
  return candidates.reduce((best, c) => (distance(c) > distance(best) ? c : best));
}

export function useFlowColors(data: Ref<FlowData | null>): Ref<Record<string, string>> {
  const colors = ref<Record<string, string>>({});
  const assigned = new Map<string, string>();

  watch(data, async (flow, _, onCleanup) => {
    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    if (!flow) return;
    const palettesBySeries = await Promise.all(flow.series.map((s) => (s.coverArt ? coverPalette(s.coverArt) : null)));
    if (cancelled) return;

    const used: number[] = [];
    const next: Record<string, string> = {};
    flow.series.forEach((series, i) => {
      if (series.other) { next[series.id] = OTHER_COLOR; return; }
      const key = `${flow.group}:${series.id}`;
      const color = assigned.get(key) ?? mostDistinct(palettesBySeries[i] ?? [fallbackFlowColor(key)], used);
      assigned.set(key, color);
      used.push(oklchHue(color));
      next[series.id] = color;
    });
    colors.value = next;
  }, { immediate: true });

  return colors;
}
