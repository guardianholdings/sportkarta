import manifest from '@/lib/marketing-shots.json';

/**
 * The product screenshots the clubs page shows, by catalogue area (and
 * `hero` for the dashboard in the first screen). Rendered by
 * scripts/marketing-shots/shots.mjs from a seeded demo club — fixture names,
 * nobody real — into public/marketing, with the manifest it writes beside
 * them (lib/marketing-shots.json) carrying each file's dimensions, so the
 * frame reserves the space before the image loads. An area with no entry
 * renders its rows without a picture.
 */
export interface Shot {
  src: string;
  width: number;
  height: number;
}

export const SHOTS: Readonly<Partial<Record<string, Shot>>> = manifest;
