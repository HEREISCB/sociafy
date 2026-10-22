import { ToolPageShell, toolJsonLd } from './text-tool-page';
import { TryTool } from './try-tool';
import { TRY_PAGES, defaultAspect, type TryAspect } from '../lib/try-presets';

type Props = {
  kind: 'image' | 'video';
  /** Page URL. Default /try-image or /try-video. */
  path?: string;
  /** Output shape for this page's platform, see lib/try-presets. */
  aspect?: TryAspect;
  examples?: string[];
  /** Tool name for structured data, e.g. "YouTube thumbnail maker". */
  toolName?: string;
  h1: React.ReactNode;
  lede: string;
  steps: [string, string][];
  faq: [string, string][];
};

/** /try-image, /try-video and the image/video /free-* pages: same shell as the text tools. */
export function TryPage({ kind, path = `/try-${kind}`, aspect, examples, toolName, h1, lede, steps, faq }: Props) {
  const name = TRY_PAGES.find((t) => t.path === path)?.title.replace(/^Free /, '') ?? `AI ${kind} generator`;
  return (
    <ToolPageShell
      path={path}
      name={name.charAt(0).toUpperCase() + name.slice(1)}
      jsonLd={toolJsonLd(`Sociafy ${toolName ?? `free AI ${kind} generator`}`, path, 'MultimediaApplication', faq)}
      h1={h1}
      lede={lede}
      steps={steps}
      faq={faq}
    >
      <TryTool kind={kind} path={path} aspect={aspect ?? defaultAspect(kind)} examples={examples} />
    </ToolPageShell>
  );
}
