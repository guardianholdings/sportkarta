/**
 * The product screenshots the clubs page shows, by catalogue area (and
 * `hero` for the dashboard in the first screen). Rendered by
 * scripts/marketing-shots from a seeded demo club — fixture names, nobody
 * real — into public/marketing; an area with no entry renders its rows
 * without a picture. Dimensions are the file's own, so the frame reserves the
 * space before the image loads.
 */
export interface Shot {
  src: string;
  width: number;
  height: number;
}

export const SHOTS: Readonly<Partial<Record<string, Shot>>> = {};
