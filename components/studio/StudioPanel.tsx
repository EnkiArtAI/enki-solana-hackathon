"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import ConfirmDialog from "@/components/kit/ConfirmDialog";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import PillMenu from "@/components/kit/PillMenu";
import { notify } from "@/components/kit/notify";
import { downloadImage } from "@/components/kit/share";
import PanelHead from "@/components/enki-shell/PanelHead";
import { Icon } from "@/components/enki-shell/icons";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useStudioApi, useStudioContent, useStudioProject, useStudioProjects } from "@/hooks/useStudio";
import {
  MAX_CHARACTERS, MAX_CONTENTS, MAX_MASTER_PROMPTS, MAX_PROJECTS, MAX_STYLES, STUDIO_NOT_READY,
  type MasterPrompt, type Project, type Style,
} from "@/lib/studio/types";
import { promptPage } from "@/lib/ui/image-view/open-link";
import { contentGoes, countsLine, plural, projectGoes } from "@/lib/ui/studio/copy";
import { hostOf } from "@/lib/ui/studio/fields";
import { createLink } from "@/lib/ui/studio/links";
import { ASSET_TYPES, AssetTile, PendingTile, assetCount, useAssetUpload, useDrop } from "./Assets";
import ContentDialog from "./ContentDialog";
import MasterPromptDialog from "./MasterPromptDialog";
import SheetPicker, { useSheets } from "./SheetPicker";
import StyleDialog from "./StyleDialog";
import "./studio.css";

export type StudioPlace = { project?: string; content?: string };

/**
 * Studio (Kev, 2026-10-30: "After clicking Next, I will then have an ordner in Studio with the name of it. When clicking
 * on it, i have the description and then sections for: Assets, Characters and then subfolders for every content piece i
 * create"): its three pages by the address, the overview of projects, a project, a content piece. Each page is keyed by
 * its id; Back walks up one level at a time (the shell's closePanel).
 */
export default function StudioPanel({ place, onPlace, onBack, onWizard, onReplace }: {
  place: StudioPlace;
  /** A page of Studio's own (pushed). */
  onPlace: (place: StudioPlace) => void;
  /** One level up (Back, Esc). */
  onBack: () => void;
  /** The project wizard: new, or editing `project`. */
  onWizard: (project?: Project) => void;
  /** After a delete: the level above, in place of the page that is gone. */
  onReplace: (place: StudioPlace) => void;
}) {
  if (place.project && place.content) {
    return <ContentPage key={place.content} project={place.project} id={place.content} onBack={onBack} onReplace={onReplace} />;
  }
  if (place.project) return <ProjectPage key={place.project} id={place.project} onPlace={onPlace} onBack={onBack} onWizard={onWizard} onReplace={onReplace} />;
  return <Overview onPlace={onPlace} onWizard={onWizard} />;
}

/** The panel's way up, as every panel's Back (DEC-468): its own line at the top left, giving way with the phone header. */
const Back = ({ onBack }: { onBack: () => void }) => (
  <button type="button" className="ek-panel-back kit-hit ek-tuck-hide" onClick={onBack} aria-label="Back" title="Back">
    <Icon name="chevronLeft" size={20} stroke={2} />
  </button>
);

/** Studio's quiet middle: a glyph, a sentence, maybe a way on. */
const Empty = ({ title, line, children }: { title: string; line?: string; children?: ReactNode }) => (
  <div className="st-empty">
    <Icon name="folder" size={28} stroke={1.5} />
    <h2 className="kit-title">{title}</h2>
    {line && <p>{line}</p>}
    {children}
  </div>
);

/** A folder: up to four pictures as its cover (a folder glyph without), its name, a mono line. */
function Folder({ name, cover, meta, onOpen, dots }: { name: string; cover: string[]; meta: string; onOpen: () => void; dots?: string[] }) {
  return (
    <button type="button" className="st-card" onClick={onOpen}>
      <span className="st-cover" data-n={Math.min(cover.length, 4)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- signed tiles */}
        {cover.length ? cover.slice(0, 4).map((src) => <img key={src} src={src} alt="" loading="lazy" draggable={false} />) : <Icon name="folder" size={30} stroke={1.4} />}
      </span>
      <span className="st-card-name">{name}</span>
      <span className="st-card-meta">{dots && dots.length > 0 && <Dots palette={dots} />}{meta}</span>
    </button>
  );
}

const Dots = ({ palette, size = 10 }: { palette: string[]; size?: number }) => (
  <span className="st-dots" aria-hidden>{palette.map((c, i) => <span key={i} style={{ background: c, width: size, height: size }} />)}</span>
);

/** A section in Kev's order: its label with how many, its add action, its row. */
function Section({ label, count, children, empty }: { label: string; count: string; children: ReactNode; empty?: string | false }) {
  return (
    <section className="st-sec">
      <h2 className="kit-label st-sec-head">{label} · {count}</h2>
      {children}
      {empty && <p className="st-note">{empty}</p>}
    </section>
  );
}

/** "+ Character", "+ Style": a dashed card first in its row. */
const AddCard = ({ label, onClick, disabled, className = "" }: { label: string; onClick: () => void; disabled?: boolean; className?: string }) => (
  <button type="button" className={`st-add ${className}`} onClick={onClick} disabled={disabled}>
    <Icon name="plus" size={18} stroke={1.8} /><span>{label}</span>
  </button>
);

/** A card's ×: shown on hover, always on touch. */
const Drop = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" className="st-x kit-hit" aria-label={label} title="Delete" onClick={(e) => { e.stopPropagation(); onClick(); }}>
    <Icon name="x" size={12} stroke={2.4} />
  </button>
);

/* The projects as folders, "+ Create project" a folder first among them (Kev, 2026-10-30: "i also wanna add a project
   inside of the studio, show it as a +create folder basically"), there from the first paint: no line before SQL 53
   ("Studio is not available yet. remove that"; the wizard says it when a save cannot land) and no loading line; the
   projects join it as they are read. */
function Overview({ onPlace, onWizard }: { onPlace: (place: StudioPlace) => void; onWizard: (project?: Project) => void }) {
  const { data, error } = useStudioProjects(true);
  const projects = data?.projects ?? [];
  return (
    <div className="ek-page st-page kit-focus">
      <PanelHead title="Studio." sub="Your projects: their pictures, characters, styles and master prompts, and the content you make with them." />
      {/* Kev, 2026-11-09 (DEC-2026-11-09-02). */}
      <p className="st-notice" role="status">Studio is a work in progress and subject to heavy change until 14 November 2026.</p>
      {error ? <Empty title={error} /> : (
        <div className="st-grid">
          <AddCard label="Create project" className="st-add--folder" onClick={() => onWizard()} disabled={projects.length >= MAX_PROJECTS} />
          {projects.map((p) => <Folder key={p.id} name={p.name} cover={p.cover} meta={countsLine(p)} onOpen={() => onPlace({ project: p.id })} />)}
        </div>
      )}
    </div>
  );
}

/** The project's kit, one line of its four parts (Kev, 2026-10-30: "i want these to be in one line that i can then
 *  responsively open and see all of them. content is the main area where i will create new content pieces through which
 *  i will access all of the things above"): a part opens below the line, one at a time. */
export type KitPart = "assets" | "characters" | "styles" | "master";
export const KIT_PARTS: ReadonlyArray<{ key: KitPart; label: string }> = [
  { key: "assets", label: "Assets" }, { key: "characters", label: "Characters" }, { key: "styles", label: "Styles" }, { key: "master", label: "Master prompts" },
];

type Ask =
  | { kind: "sheet" } | { kind: "content" } | { kind: "delete" }
  | { kind: "style"; style?: Style } | { kind: "master"; master?: MasterPrompt }
  | { kind: "drop"; what: "characters" | "styles" | "master-prompts"; id: string; name: string; text: string };

function ProjectPage({ id, onPlace, onBack, onWizard, onReplace }: {
  id: string;
  onPlace: (place: StudioPlace) => void;
  onBack: () => void;
  onWizard: (project?: Project) => void;
  onReplace: (place: StudioPlace) => void;
}) {
  const { data, notReady, error } = useStudioProject(id);
  const api = useStudioApi();
  const phone = useMediaQuery("(max-width: 767.98px)");
  const [ask, setAsk] = useState<Ask | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [part, setPart] = useState<KitPart | null>(null);
  // The part last opened stays drawn while the line folds shut, so the fold closes over it.
  const [drawn, setDrawn] = useState<KitPart>("assets");
  if (part && part !== drawn) setDrawn(part);
  const shown = part ?? drawn;
  const upload = useAssetUpload(id);
  const drop = useDrop((files) => void upload.add(files));
  const input = useRef<HTMLInputElement>(null);
  const sheets = useSheets(!!data?.characters.some((c) => c.sheetPromptId)).data ?? [];
  if (!data) {
    return <><Back onBack={onBack} /><div className="ek-page st-page kit-focus"><Empty title={notReady ? STUDIO_NOT_READY : error ?? "Loading the project…"} /></div></>;
  }
  const { project, assets, characters, styles, masterPrompts, contents } = data;
  const fail = (e: Error) => notify(e.message, { tone: "error" });

  return (
    <>
      <Back onBack={onBack} />
      <div className="ek-page st-page kit-focus">
        <PanelHead title={`${project.name}.`} sub={project.description ?? undefined}>
          <div className="st-head-acts">
            {project.link && (
              <a className="st-chip" href={project.link} target="_blank" rel="noopener noreferrer">
                {hostOf(project.link)}<Icon name="arrowRight" size={13} stroke={2} />
              </a>
            )}
            <button type="button" className="st-btn" onClick={() => onWizard(project)}><Icon name="pen" size={14} stroke={1.8} />Edit</button>
            <span className="st-more">
              <PillMenu trigger={<Icon name="dots" size={15} stroke={2} />} ariaLabel="More" title={project.name} value={null}
                options={[{ key: "delete", label: "Delete project" }]} onPick={() => setAsk({ kind: "delete" })} />
            </span>
          </div>
        </PanelHead>

        {/* The kit in one line, its counts and a glance at each; a part opens below it with all it holds. */}
        <div className="st-kit" role="group" aria-label="The project's kit">
          {KIT_PARTS.map(({ key, label }) => {
            const [count, peek] = key === "assets" ? [assetCount(assets.length), assets.slice(0, 3).map((a) => a.thumb)]
              : key === "characters" ? [`${characters.length} / ${MAX_CHARACTERS}`, characters.flatMap((c) => (c.picture ? [c.picture.thumb] : [])).slice(0, 3)]
              : key === "styles" ? [`${styles.length} / ${MAX_STYLES}`, []]
              : [`${masterPrompts.length} / ${MAX_MASTER_PROMPTS}`, []];
            return (
              <button key={key} type="button" className="st-kit-tab" aria-expanded={part === key} aria-controls="st-kit-part"
                onClick={() => setPart(part === key ? null : key)}>
                <span className="st-kit-top"><span className="kit-label">{label}</span><Icon name="chevronRight" size={13} stroke={2} /></span>
                <span className="st-kit-count">{count}</span>
                <span className="st-kit-peek" aria-hidden>
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed tiles */}
                  {peek.map((src) => <img key={src} src={src} alt="" loading="lazy" draggable={false} />)}
                  {key === "styles" && styles[0]?.palette.length ? <Dots palette={styles[0].palette} size={12} /> : null}
                  {key === "master" && masterPrompts[0] ? <span className="st-kit-name">{masterPrompts[0].name}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
        <div className="st-kit-panel" data-open={part ? "" : undefined}>
          <div id="st-kit-part" className="st-kit-in" inert={!part}>
            {shown === "assets" && (
              <Section label="Assets" count={assetCount(assets.length)} empty={!assets.length && !upload.pending.length && "Logos, products, places: pictures every content piece can use."}>
                <div className="st-row">
                  <button type="button" className="st-add st-add--square" data-over={drop.over || undefined} onClick={() => input.current?.click()} {...drop.bind}>
                    <Icon name="plus" size={18} stroke={1.8} /><span>Add</span>
                  </button>
                  <input ref={input} type="file" accept={ASSET_TYPES} multiple hidden
                    onChange={(e) => { void upload.add([...(e.target.files ?? [])]); e.target.value = ""; }} />
                  {assets.map((a, i) => <AssetTile key={a.id} asset={a} projectName={project.name} onOpen={() => setViewing(i)} />)}
                  {upload.pending.map((src) => <PendingTile key={src} src={src} />)}
                </div>
              </Section>
            )}
            {shown === "characters" && (
              <Section label="Characters" count={`${characters.length} / ${MAX_CHARACTERS}`} empty={!characters.length && "Put your character into a sheet once, then use them everywhere."}>
                <div className="st-row">
                  <AddCard label="Character" className="st-add--tall" onClick={() => setAsk({ kind: "sheet" })} disabled={characters.length >= MAX_CHARACTERS} />
                  {characters.map((c) => (
                    <figure key={c.id} className="st-char">
                      <span className="st-char-pic">
                        {/* eslint-disable-next-line @next/next/no-img-element -- a signed tile */}
                        {c.picture ? <img src={c.picture.thumb} alt="" loading="lazy" draggable={false} /> : <span className="st-char-gone">Picture deleted</span>}
                        <Drop label={`Delete ${c.name}`} onClick={() => setAsk({ kind: "drop", what: "characters", id: c.id, name: c.name,
                          text: c.source === "render" ? "Its render stays in your gallery." : "Its picture stays in the assets." })} />
                      </span>
                      <figcaption><span className="st-char-name">{c.name}</span>
                        {c.sheetPromptId && <span className="st-char-sheet">{sheets.find((s) => s.id === c.sheetPromptId)?.title ?? ""}</span>}</figcaption>
                    </figure>
                  ))}
                </div>
              </Section>
            )}
            {shown === "styles" && (
              <Section label="Styles" count={`${styles.length} / ${MAX_STYLES}`}>
                <div className="st-cards">
                  <AddCard label="Style" onClick={() => setAsk({ kind: "style" })} disabled={styles.length >= MAX_STYLES} />
                  {styles.map((s) => (
                    <div key={s.id} className="st-item">
                      <button type="button" className="st-item-body" onClick={() => setAsk({ kind: "style", style: s })}>
                        <span className="st-item-name">{s.name}</span>
                        {s.palette.length > 0 && <Dots palette={s.palette} size={16} />}
                        {s.words && <span className="st-item-text st-clamp-2">{s.words}</span>}
                      </button>
                      <Drop label={`Delete ${s.name}`} onClick={() => setAsk({ kind: "drop", what: "styles", id: s.id, name: s.name, text: "Content pieces with it go on without a style." })} />
                    </div>
                  ))}
                </div>
              </Section>
            )}
            {shown === "master" && (
              <Section label="Master prompts" count={`${masterPrompts.length} / ${MAX_MASTER_PROMPTS}`}>
                <div className="st-cards">
                  <AddCard label="Master prompt" onClick={() => setAsk({ kind: "master" })} disabled={masterPrompts.length >= MAX_MASTER_PROMPTS} />
                  {masterPrompts.map((p) => (
                    <div key={p.id} className="st-item">
                      <button type="button" className="st-item-body" onClick={() => setAsk({ kind: "master", master: p })}>
                        <span className="st-item-name">{p.name}</span>
                        <span className="st-item-text st-clamp-3">{p.prompt}</span>
                      </button>
                      <button type="button" className="st-copy" onClick={() => void navigator.clipboard.writeText(p.prompt)
                        .then(() => notify("Copied the master prompt"), () => notify("Couldn't copy that", { tone: "error" }))}>Copy</button>
                      <Drop label={`Delete ${p.name}`} onClick={() => setAsk({ kind: "drop", what: "master-prompts", id: p.id, name: p.name, text: "Content pieces with it go on without a master prompt." })} />
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>

        <Section label="Content" count={`${contents.length} / ${MAX_CONTENTS}`} empty={!contents.length && "A content piece is one launch, post or campaign. Its renders collect here."}>
          <div className="st-grid">
            <AddCard label="Content" className="st-add--folder" onClick={() => setAsk({ kind: "content" })} disabled={contents.length >= MAX_CONTENTS} />
            {contents.map((c) => (
              <Folder key={c.id} name={c.name} cover={c.cover} meta={plural(c.count, "image")} dots={styles.find((s) => s.id === c.styleId)?.palette}
                onOpen={() => onPlace({ project: id, content: c.id })} />
            ))}
          </div>
        </Section>
      </div>

      {viewing !== null && assets[viewing] && (
        <FullscreenViewer items={assets.map((a) => ({ key: a.id, src: a.url }))} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)}
          layout={phone ? "stacked" : "side"} nav={phone ? "dots" : "thumbs"}
          panel={<div className="st-vpanel">
            <button type="button" className="st-vact kit-hit" onClick={() => void downloadImage(assets[viewing].url, project.name)}>
              <Icon name="download" size={18} stroke={1.8} />Download
            </button>
          </div>} />
      )}
      {ask?.kind === "sheet" && <SheetPicker project={id} onClose={() => setAsk(null)} />}
      {ask?.kind === "content" && (
        <ContentDialog project={data} onClose={() => setAsk(null)} onDone={(c) => { setAsk(null); onPlace({ project: id, content: c.id }); }} />
      )}
      {ask?.kind === "style" && <StyleDialog project={id} style={ask.style} onClose={() => setAsk(null)} />}
      {ask?.kind === "master" && <MasterPromptDialog project={id} master={ask.master} onClose={() => setAsk(null)} />}
      {ask?.kind === "delete" && (
        <ConfirmDialog title={`Delete ${project.name}?`} text={projectGoes(data)} confirmLabel="Delete project" onCancel={() => setAsk(null)}
          onConfirm={() => { setAsk(null); api.deleteProject(id).then(() => onReplace({}), fail); }} />
      )}
      {ask?.kind === "drop" && (
        <ConfirmDialog title={`Delete ${ask.name}?`} text={ask.text} onCancel={() => setAsk(null)}
          onConfirm={() => { setAsk(null); api.deleteItem(ask.what, ask.id).catch(fail); }} />
      )}
    </>
  );
}

function ContentPage({ project: projectId, id, onBack, onReplace }: {
  project: string;
  id: string;
  onBack: () => void;
  onReplace: (place: StudioPlace) => void;
}) {
  const { data, notReady, error } = useStudioContent(id);
  const detail = useStudioProject(projectId).data;
  const api = useStudioApi();
  const router = useRouter();
  const phone = useMediaQuery("(max-width: 767.98px)");
  const [ask, setAsk] = useState<"edit" | "delete" | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  if (!data || data.project.id !== projectId) {
    const said = notReady ? STUDIO_NOT_READY : error ?? (data ? "Not found" : "Loading the content piece…");
    return <><Back onBack={onBack} /><div className="ek-page st-page kit-focus"><Empty title={said} /></div></>;
  }
  const { content, images } = data;
  const style = detail?.styles.find((s) => s.id === content.styleId);
  const master = detail?.masterPrompts.find((p) => p.id === content.masterPromptId);
  const create = (tool: "image" | "video") => router.push(createLink(tool, { project: projectId, content: id }));
  const fail = (e: Error) => notify(e.message, { tone: "error" });
  const shown = viewing !== null ? images[viewing] : undefined;

  return (
    <>
      <Back onBack={onBack} />
      <div className="ek-page st-page kit-focus" data-foot={phone || undefined}>
        <button type="button" className="kit-label st-crumb" onClick={onBack}>{data.project.name} /</button>
        <PanelHead title={`${content.name}.`} sub={content.description ?? undefined}>
          <div className="st-head-acts">
            {content.link && (
              <a className="st-chip" href={content.link} target="_blank" rel="noopener noreferrer">
                {hostOf(content.link)}<Icon name="arrowRight" size={13} stroke={2} />
              </a>
            )}
            <button type="button" className="st-btn" onClick={() => setAsk("edit")} disabled={!detail}><Icon name="pen" size={14} stroke={1.8} />Edit</button>
            <button type="button" className="st-btn" onClick={() => setAsk("delete")}><Icon name="trash" size={14} stroke={1.8} />Delete</button>
          </div>
        </PanelHead>

        <div className="st-create">
          <button type="button" className="st-btn st-btn--cta" onClick={() => create("image")}><Icon name="image" size={15} stroke={1.8} />Create image</button>
          <button type="button" className="st-btn" onClick={() => create("video")}><Icon name="film" size={15} stroke={1.8} />Create video</button>
        </div>
        {(style || master) && (
          <p className="st-uses">
            <span className="kit-label">Uses</span>
            {style && <button type="button" className="st-chip" onClick={() => setAsk("edit")}><Dots palette={style.palette} />{style.name}</button>}
            {master && <button type="button" className="st-chip" onClick={() => setAsk("edit")}>{master.name}</button>}
          </p>
        )}

        {images.length ? (
          <div className="st-renders">
            {images.map((im, i) => (
              <button key={im.imageId} type="button" className="st-render" onClick={() => setViewing(i)}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a render's thumbnail */}
                <img src={im.thumb} alt="" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        ) : (
          <Empty title="No images yet." line={`What you create from here is filed in ${content.name}.`}>
            <button type="button" className="st-btn st-btn--cta" onClick={() => create("image")}>Create image</button>
          </Empty>
        )}

        {detail && (detail.assets.length > 0 || detail.characters.length > 0) && (
          <section className="st-sec st-brought">
            <h2 className="kit-label st-sec-head">Available in Create&apos;s picker</h2>
            <div className="st-row">
              {detail.assets.map((a) => (
                // eslint-disable-next-line @next/next/no-img-element -- a signed tile
                <span key={a.id} className="st-tile"><span className="st-tile-pic"><img src={a.thumb} alt="" loading="lazy" draggable={false} /></span></span>
              ))}
              {detail.characters.flatMap((c) => (c.picture ? [(
                <figure key={c.id} className="st-char st-char--small">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a signed tile */}
                  <span className="st-char-pic"><img src={c.picture.thumb} alt="" loading="lazy" draggable={false} /></span>
                  <figcaption><span className="st-char-name">{c.name}</span></figcaption>
                </figure>
              )] : []))}
            </div>
          </section>
        )}
      </div>

      {shown && (
        <FullscreenViewer items={images.map((im) => ({ key: im.imageId, src: im.url }))} index={viewing!} onIndex={setViewing} onClose={() => setViewing(null)}
          layout={phone ? "stacked" : "side"} nav={phone ? "dots" : "thumbs"}
          panel={<div className="st-vpanel">
            <button type="button" className="st-vact kit-hit" onClick={() => void downloadImage(shown.url, content.name)}>
              <Icon name="download" size={18} stroke={1.8} />Download
            </button>
            {shown.promptId && (
              <button type="button" className="st-vact kit-hit" onClick={() => router.push(promptPage(shown.promptId!))}>
                <Icon name="sparkles" size={18} stroke={1.8} />Open its prompt
              </button>
            )}
            <button type="button" className="st-vact kit-hit" onClick={() => {
              setViewing(null);
              api.unfileImage(id, shown.imageId).catch(fail);
            }}>
              <Icon name="x" size={18} stroke={1.8} />Remove from {content.name}
            </button>
          </div>} />
      )}
      {ask === "edit" && detail && <ContentDialog project={detail} content={content} onClose={() => setAsk(null)} onDone={() => setAsk(null)} />}
      {ask === "delete" && (
        <ConfirmDialog title={`Delete ${content.name}?`} text={contentGoes(images.length)} onCancel={() => setAsk(null)}
          onConfirm={() => { setAsk(null); api.deleteContent(id).then(() => onReplace({ project: projectId }), fail); }} />
      )}
    </>
  );
}
