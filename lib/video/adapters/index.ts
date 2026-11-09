import { byteplus } from "./byteplus";
import type { VideoAdapter } from "./types";

/** Each operator's file, under the name video_routes.operator holds. A file here reaches nothing until a row names it and its key is set (lib/video/routes availableAt). */
export const VIDEO_ADAPTERS: Readonly<Record<string, VideoAdapter>> = { byteplus };
