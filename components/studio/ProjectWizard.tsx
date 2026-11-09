"use client";

import { useRef, useState } from "react";
import { notify } from "@/components/kit/notify";
import { Icon } from "@/components/enki-shell/icons";
import { useStudioApi, useStudioProject } from "@/hooks/useStudio";
import { MAX_PROJECT_ASSETS, type Project } from "@/lib/studio/types";
import { detailsInput, detailsProblem, fieldOf, type DetailField, type Details } from "@/lib/ui/studio/fields";
import { ASSET_TYPES, AssetTile, PendingTile, assetCount, useAssetUpload, useDrop } from "./Assets";
import DetailFields from "./DetailFields";
import { SheetFoot, SheetGrid, useOpenSheet } from "./SheetPicker";
import StudioDialog from "./StudioDialog";

type Step = "details" | "assets" | "sheets";

/**
 * Create project (Kev, 2026-10-30: "kommt dann ein großes popup zum eingeben von daten wie: Name, Description, Link. beim
 * click auf Next wird nach assets gefragt die ich rein laden kann. hier kann ich auch Create Characters clicken ...
 * After clicking Next, I will then have an ordner in Studio with the name of it"). Step 1's Next creates the project,
 * so its folder is in the menu at once and step 2 has a place for its pictures and characters; Back and Next again save
 * the edits. Leaving step 2 any way keeps the project. Edit mode is step 1 alone, saving. One frame for every step.
 */
export default function ProjectWizard({ edit, onClose, onOpen }: {
  /** The project to edit; none for a new one. */
  edit?: Project;
  onClose: () => void;
  /** Opens the project's page. */
  onOpen: (id: string) => void;
}) {
  const api = useStudioApi();
  const [step, setStep] = useState<Step>("details");
  const [details, setDetails] = useState<Details>({ name: edit?.name ?? "", description: edit?.description ?? "", link: edit?.link ?? "" });
  const [problem, setProblem] = useState<{ field: DetailField; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Project | null>(edit ?? null);
  const [picked, setPicked] = useState<string | null>(null);
  const assets = useStudioProject(edit ? null : made?.id ?? null).data?.assets ?? [];
  const upload = useAssetUpload(made?.id ?? "");
  const drop = useDrop((files) => void upload.add(files));
  const input = useRef<HTMLInputElement>(null);
  const openSheet = useOpenSheet(made?.id ?? "");

  const save = async () => {
    if (busy) return;
    const p = detailsProblem(details);
    if (p) return setProblem(p);
    setBusy(true);
    try {
      const { project } = made ? await api.updateProject(made.id, detailsInput(details)) : await api.createProject(detailsInput(details));
      setMade(project);
      if (edit) onClose();
      else setStep("assets");
    } catch (e) {
      const message = (e as Error).message;
      const field = fieldOf(message);
      if (field) setProblem({ field, message });
      else notify(message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  // Once made, the project stays, however the dialog goes.
  const leave = () => {
    if (made && !edit) notify(`${made.name} is in Studio.`);
    onClose();
  };
  const marks = !edit && (
    <><span data-on={step === "details" || undefined}>1 Details</span> · <span data-on={step !== "details" || undefined}>2 Assets</span></>
  );

  if (step === "sheets") {
    return (
      <StudioDialog step={step} title="Pick a character sheet." marks={marks} onClose={leave}
        foot={<SheetFoot picked={picked} onBack={() => setStep("assets")} onUse={() => { onClose(); openSheet(picked!); }} />}>
        <SheetGrid picked={picked} onPick={setPicked} />
      </StudioDialog>
    );
  }
  if (step === "assets") {
    const full = assets.length + upload.pending.length >= MAX_PROJECT_ASSETS;
    return (
      <StudioDialog step={step} title="Assets & characters." marks={marks} onClose={leave}
        foot={<>
          <button type="button" className="st-btn st-btn--quiet" onClick={() => setStep("details")}>← Back</button>
          <button type="button" className="st-btn st-btn--cta" data-autofocus onClick={() => { onClose(); onOpen(made!.id); }}>Open project</button>
        </>}>
        <section className="st-step">
          <div className="st-step-head"><span className="kit-label">Assets</span><span className="st-count">{assetCount(assets.length)}</span></div>
          <p className="st-line">Pictures every content piece can use: logos, products, places, people.</p>
          <button type="button" className="st-drop" data-over={drop.over || undefined} disabled={full} onClick={() => input.current?.click()} {...drop.bind}>
            <Icon name="imageDrop" size={22} stroke={1.6} />
            <span>Drop pictures or <u>browse</u></span>
          </button>
          <input ref={input} type="file" accept={ASSET_TYPES} multiple hidden
            onChange={(e) => { void upload.add([...(e.target.files ?? [])]); e.target.value = ""; }} />
          {(assets.length > 0 || upload.pending.length > 0) && (
            <div className="st-tiles">
              {assets.map((a) => <AssetTile key={a.id} asset={a} projectName={made!.name} />)}
              {upload.pending.map((src) => <PendingTile key={src} src={src} />)}
            </div>
          )}
        </section>
        <section className="st-step">
          <div className="st-step-head"><span className="kit-label">Characters</span></div>
          <p className="st-line">Pick a character sheet and put your character in it. Each render is priced on Generate, like any other.</p>
          <button type="button" className="st-btn" onClick={() => setStep("sheets")}><Icon name="sparkles" size={15} stroke={1.8} />Create character</button>
        </section>
      </StudioDialog>
    );
  }
  return (
    <StudioDialog step={step} title={edit ? "Edit project." : "New project."} marks={marks} onClose={leave}
      foot={<>
        <button type="button" className="st-btn st-btn--quiet" onClick={leave}>Cancel</button>
        <button type="button" className="st-btn st-btn--cta" aria-disabled={!details.name.trim() || busy || undefined} onClick={() => void save()}>
          {busy ? (edit ? "Saving…" : "Creating…") : edit ? "Save" : "Next →"}
        </button>
      </>}>
      <DetailFields value={details} onChange={(v) => { setDetails(v); setProblem(null); }} problem={problem} onEnter={() => void save()} />
    </StudioDialog>
  );
}
