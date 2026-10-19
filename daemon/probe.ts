import { readSidebar } from './cmux';
import { openTail, piLinks, sessionFile } from './pi';

const links = await piLinks();
const sidebar = await readSidebar(links);
const piSurfaces = sidebar.workspaces.flatMap((workspace) => workspace.surfaces.filter((surface) => surface.pi !== null).map((surface) => ({ workspace: workspace.title, surface })));
const first = piSurfaces.find((each) => each.surface.pi?.status === 'running') ?? piSurfaces[0];
const path = first?.surface.pi ? await sessionFile(first.surface.pi.sessionId) : null;
const tail = path ? await openTail(path) : null;

console.log(
  JSON.stringify(
    {
      workspaces: sidebar.workspaces.length,
      groups: sidebar.groups.length,
      pinned: sidebar.workspaces.filter((workspace) => workspace.pinned).length,
      piSurfaces: piSurfaces.length,
      sample: first ? { workspace: first.workspace, title: first.surface.title, status: first.surface.pi?.status, file: path !== null, entries: tail?.entries.length ?? 0, last: tail?.entries.at(-1)?.text.slice(0, 80) } : null,
    },
    null,
    1,
  ),
);
