// Media in a note (an embed, `![[photo.png]]`) and in the file view: a picture with its keys (Edit opens the
// kit's image editor, Full screen), a video or a sound in the kit's player. Saving an edited picture writes
// it over the file and sends the original to the trash, so it can come back.
import { Key } from "@paperboatlab/ui";
import { ImageEditor, MediaPlayer } from "@paperboatlab/ui/media";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api.ts";
import { EDITABLE, FileGlyph, mediaOf, typeOf } from "./files.tsx";

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** `readOnly`: no Edit (an example where it is). */
export function MediaEmbed({ path, alt, version, onSaved, fail, readOnly }: {
  path: string | null; alt: string; version?: number; onSaved?: (p: string) => void; fail: (e: unknown) => void; readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false), [stamp, setStamp] = useState(0);
  const fig = useRef<HTMLElement>(null);
  if (!path) return <span className="embed-card miss"><b>{alt || "a missing file"}</b><small>not in the hub (yet)</small></span>;
  const kind = mediaOf(path), src = api.raw(path, (version ?? 0) + stamp), name = base(path);
  if (kind === "video" || kind === "audio") return <div className="media"><MediaPlayer src={src} kind={kind} title={alt || name} /></div>;
  if (kind !== "image") return <span className="embed-card" data-wl={path}><b>{name}</b><small>a file in the hub</small></span>;
  const type = readOnly ? undefined : EDITABLE[typeOf(path)];
  return (
    <figure ref={fig} className="media img">
      <img src={src} alt={alt || name} loading="lazy" />
      <span className="mkeys" data-keep>
        {type && <Key size="sm" kind="quiet" round icon="edit" label="Edit (crop, rotate)" onClick={() => setEditing(true)} />}
        <Key size="sm" kind="quiet" round icon="media-fullscreen" label="Full screen" onClick={() => fig.current?.requestFullscreen().catch(() => {})} />
      </span>
      {alt && <figcaption>{alt}</figcaption>}
      {editing && type && createPortal(
        <div className="imgedit-overlay" role="dialog" aria-modal="true" aria-label={`Edit ${name}`} onKeyDown={(e) => e.key === "Escape" && setEditing(false)}>
          <div className="imgedit-head"><FileGlyph path={path} /><b>{name}</b><small>Save writes over the file; the original goes to the trash.</small></div>
          <ImageEditor src={src} type={type} name={name} onCancel={() => setEditing(false)}
            onSave={(blob) => api.upload(path, blob, true).then(() => { setStamp(Date.now()); setEditing(false); onSaved?.(path); }, fail)} />
        </div>, document.body)}
    </figure>
  );
}
