import { Operation } from 'fast-json-patch';
import { moment } from 'obsidian';

import { Board, DataTypes, Item, Lane } from 'src/components/types';
import { Path } from 'src/dnd/types';
import { getEntityFromPath } from 'src/dnd/util/data';
import { renderMarkdown } from 'src/helpers/renderMarkdown';
import { StateManager } from 'src/StateManager';

import { getSearchValue } from '../common';

export async function hydrateLane(stateManager: StateManager, lane: Lane) {
  try {
    const laneTitleDom = await renderMarkdown(
      stateManager.getAView(),
      lane.data.title
    );
    lane.data.dom = laneTitleDom;

    return lane;
  } catch (e) {
    stateManager.setError(e);
    throw e;
  }
}

export async function hydrateItem(stateManager: StateManager, item: Item) {
  let itemTitleDom: HTMLDivElement;

  try {
    const viewToRenderTo = stateManager.getAView();
    itemTitleDom = await renderMarkdown(viewToRenderTo, item.data.title);
    console.log(viewToRenderTo);
  } catch (e) {
    stateManager.setError(e);
    throw e;
  }

  item.data.dom = itemTitleDom;
  console.log(item.data.dom);
  item.data.titleSearch = getSearchValue(
    itemTitleDom,
    item.data.metadata.tags,
    item.data.metadata.fileMetadata
  );

  const { dateStr, timeStr, fileAccessor, codeResultStr } = item.data.metadata;

  if (dateStr) {
    item.data.metadata.date = moment(
      dateStr,
      stateManager.getSetting('date-format')
    );
  }

  if (timeStr) {
    let time = moment(timeStr, stateManager.getSetting('time-format'));

    if (item.data.metadata.date) {
      const date = item.data.metadata.date;

      date.hour(time.hour());
      date.minute(time.minute());
      date.second(time.second());

      time = date.clone();
    }

    item.data.metadata.time = time;
  }

  if (fileAccessor) {
    const file = stateManager.app.metadataCache.getFirstLinkpathDest(
      fileAccessor.target,
      stateManager.file.path
    );

    if (file) {
      item.data.metadata.file = file;
    }
  }

  if (codeResultStr) {
    if (!stateManager.app.plugins.enabledPlugins.has('dataview')) {
      item.data.metadata.codeResult =
        'Please install/enable dataview for this to work';
      return item;
    }

    console.log(codeResultStr.startsWith('query'));
    if (codeResultStr.startsWith('queryjs')) {
      const splitCode = codeResultStr.split('<br>');
      // Remove the first element that is langauge type
      splitCode.shift();

      if (splitCode[splitCode.length - 1] === '') {
        // Remove empty last element
        splitCode.pop();
      }

      if (splitCode.length === 1) {
        item.data.metadata.codeResult = `Something went wrong parsing: ${codeResultStr}`;
        return item;
      }

      /*
      TABLE WITHOUT ID
link(key, meta(key).subpath) AS Day,
rows.Lists.text AS Content FROM #project/test
FLATTEN file.lists AS Lists
GROUP BY Lists.section"groupBy(l => l.section.subpath))
      */

      const currentView = stateManager.getAView();
      const cleanCode = splitCode.join('\n');
      // eslint-disable-next-line
      // @ts-ignore
      await stateManager.app.plugins.plugins.dataview?.dataviewjs(
        cleanCode,
        itemTitleDom,
        currentView,
        currentView.file.path
      );
    } else if (codeResultStr.startsWith('query')) {
      const [, code] = codeResultStr.split('<br>');
      if (!code) {
        item.data.metadata.codeResult = `Something went wrong parsing dql: ${codeResultStr}`;
        return item;
      }

      const cleanCode = code.replace('<br>', '\n');
      const result = await stateManager.app.plugins.plugins.dataview.api[
        'query'
      ](cleanCode);
      // TODO: Render to proper md and attach to dom
      console.log(result);
    }
  }

  return item;
}

export async function hydrateBoard(
  stateManager: StateManager,
  board: Board
): Promise<Board> {
  try {
    await Promise.all(
      board.children.map(async (lane) => {
        try {
          await hydrateLane(stateManager, lane);
          await Promise.all(
            lane.children.map((item) => {
              return hydrateItem(stateManager, item);
            })
          );
        } catch (e) {
          stateManager.setError(e);
          throw e;
        }
      })
    );
  } catch (e) {
    stateManager.setError(e);
    throw e;
  }

  return board;
}

function opAffectsHydration(op: Operation) {
  return (
    (op.op === 'add' || op.op === 'replace') &&
    [
      '/title',
      '/titleRaw',
      '/dateStr',
      '/timeStr',
      /\d$/,
      /\/fileAccessor\/.+$/,
    ].some((postFix) => {
      if (typeof postFix === 'string') {
        return op.path.endsWith(postFix);
      } else {
        return postFix.test(op.path);
      }
    })
  );
}

export async function hydratePostOp(
  stateManager: StateManager,
  board: Board,
  ops: Operation[]
): Promise<Board> {
  const seen: Record<string, boolean> = {};
  const toHydrate = ops.reduce((paths, op) => {
    if (!opAffectsHydration(op)) {
      return paths;
    }

    const path = op.path.split('/').reduce((path, segment) => {
      if (/\d+/.test(segment)) {
        path.push(Number(segment));
      }

      return path;
    }, [] as Path);

    const key = path.join(',');

    if (!seen[key]) {
      seen[key] = true;
      paths.push(path);
    }

    return paths;
  }, [] as Path[]);

  try {
    await Promise.all(
      toHydrate.map((path) => {
        const entity = getEntityFromPath(board, path);

        if (entity.type === DataTypes.Lane) {
          return hydrateLane(stateManager, entity);
        }

        if (entity.type === DataTypes.Item) {
          return hydrateItem(stateManager, entity);
        }
      })
    );
  } catch (e) {
    stateManager.setError(e);
    throw e;
  }

  return board;
}
