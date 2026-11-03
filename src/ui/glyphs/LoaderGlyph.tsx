/**
 * Original loader glyphs (DESIGN.md §7): drawn on a 16-unit grid with 1.5px strokes, currentColor,
 * shown at 12 or 16px. Deliberately geometric so none resembles an official logo.
 */
import type { ReactNode } from 'react';

import type { LoaderKind } from '../../bindings';
import { LOADER_NAME } from './loaders';

export interface GlyphProps {
  size?: 12 | 16;
  /** Accessible name; omit when adjacent text already names the loader. */
  title?: string;
  className?: string;
}

function Svg({ size = 16, title, className, children }: GlyphProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Anvil-face trapezoid: wide top edge narrowing toward the base. */
const TRAPEZOID = 'M2.75 4.25 H13.25 L10.75 11.75 H5.25 Z';

/** Forge: anvil-face trapezoid with a horizontal bar. */
export function ForgeGlyph(props: GlyphProps) {
  return (
    <Svg {...props}>
      <path d={TRAPEZOID} />
      <path d="M4.25 8 H11.75" />
    </Svg>
  );
}

/** NeoForge: the same trapezoid split by a diagonal. */
export function NeoForgeGlyph(props: GlyphProps) {
  return (
    <Svg {...props}>
      <path d={TRAPEZOID} />
      <path d="M2.75 4.25 L10.75 11.75" />
    </Svg>
  );
}

/** Fabric: three parallel threads crossed by one. */
export function FabricGlyph(props: GlyphProps) {
  return (
    <Svg {...props}>
      <path d="M2.25 7.25 L7.25 2.25" />
      <path d="M4.25 11.75 L11.75 4.25" />
      <path d="M8.75 13.75 L13.75 8.75" />
      <path d="M3.25 3.25 L12.75 12.75" />
    </Svg>
  );
}

/** Quilt: a 2×2 patch grid with the last cell knocked out of line. */
export function QuiltGlyph(props: GlyphProps) {
  return (
    <Svg {...props}>
      <rect x="2.25" y="2.25" width="4.5" height="4.5" />
      <rect x="8.25" y="2.25" width="4.5" height="4.5" />
      <rect x="2.25" y="8.25" width="4.5" height="4.5" />
      <rect x="9.25" y="9.25" width="4.5" height="4.5" />
    </Svg>
  );
}

/** Legacy Forge: the Forge glyph, dashed. */
export function LegacyForgeGlyph(props: GlyphProps) {
  return (
    <Svg {...props}>
      <g strokeDasharray="2 1.5" strokeLinecap="butt">
        <path d={TRAPEZOID} />
        <path d="M4.25 8 H11.75" />
      </g>
    </Svg>
  );
}

/** Unknown: a hollow square with a mono `?`. */
export function UnknownGlyph(props: GlyphProps) {
  return (
    <Svg {...props}>
      <rect x="2.25" y="2.25" width="11.5" height="11.5" />
      <text
        x="8"
        y="11.25"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="var(--f-mono)"
        fontSize="9"
        fontWeight="500"
      >
        ?
      </text>
    </Svg>
  );
}

const BY_KIND: Record<LoaderKind, (p: GlyphProps) => ReactNode> = {
  forge: ForgeGlyph,
  neoforge: NeoForgeGlyph,
  fabric: FabricGlyph,
  quilt: QuiltGlyph,
  legacyforge: LegacyForgeGlyph,
  unknown: UnknownGlyph,
};

export function LoaderGlyph({ kind, labelled = false, ...rest }: GlyphProps & { kind: LoaderKind | null; labelled?: boolean }) {
  const k = kind ?? 'unknown';
  const Glyph = BY_KIND[k];
  return <Glyph {...rest} title={labelled ? LOADER_NAME[k] : rest.title} />;
}
