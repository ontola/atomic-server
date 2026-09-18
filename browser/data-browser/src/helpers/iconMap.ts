import {
  ai,
  canvas,
  collections,
  commits,
  core,
  dataBrowser,
  Datatype,
  server,
} from '@tomic/react';
import { IconType } from 'react-icons';
import {
  FaTag,
  FaAtom,
  FaBook,
  FaGlobe,
  FaClock,
  FaComment,
  FaCube,
  FaCubes,
  FaFile,
  FaFileLines,
  FaFileImport,
  FaFolder,
  FaHashtag,
  FaHardDrive,
  FaList,
  FaShapes,
  FaShareFromSquare,
  FaTable,
  FaChartLine,
  FaArrowUpRightFromSquare,
  FaCalendar,
  FaFont,
  FaListUl,
  FaMarkdown,
  FaPaintbrush,
  FaRegSquareCheck,
  FaLanguage,
  FaLink,
  FaCode,
  FaPuzzlePiece,
  FaVideo,
} from 'react-icons/fa6';
import { AIIcon } from '../components/AI/AIIcon';

const iconMap = new Map<string, IconType>([
  [dataBrowser.classes.folder, FaFolder],
  [dataBrowser.classes.bookmark, FaBook],
  [dataBrowser.classes.chatroom, FaComment],
  [dataBrowser.classes.document, FaFileLines],
  [dataBrowser.classes.documentV2, FaFileLines],
  [dataBrowser.classes.meeting, FaVideo],
  [server.classes.file, FaFile],
  [server.classes.drive, FaHardDrive],
  [server.classes.plugin, FaPuzzlePiece],
  [server.classes.installation, FaPuzzlePiece],
  [commits.classes.commit, FaClock],
  [dataBrowser.classes.importer, FaFileImport],
  [server.classes.invite, FaShareFromSquare],
  [collections.classes.collection, FaList],
  [core.classes.class, FaCube],
  [core.classes.property, FaCubes],
  [dataBrowser.classes.table, FaTable],
  [dataBrowser.classes.dashboard, FaChartLine],
  [core.classes.property, FaHashtag],
  [core.classes.ontology, FaShapes],
  [dataBrowser.classes.tag, FaTag],
  [ai.classes.aiChat, AIIcon],
  [canvas.classes.canvas, FaPaintbrush],
]);

/**
 * Classes created per drive from a schema (no fixed subject) are matched by
 * their shortname instead.
 */
const classShortnameIconMap = new Map<string, IconType>([
  ['website-project', FaGlobe],
]);

export function getIconForClass(
  classSubject: string | undefined,
  fallback: IconType = FaAtom,
  classShortname?: string,
): IconType {
  return (
    (classSubject ? iconMap.get(classSubject) : undefined) ??
    (classShortname ? classShortnameIconMap.get(classShortname) : undefined) ??
    fallback
  );
}

export const dataTypeIconMap = new Map<string, IconType>([
  [Datatype.STRING, FaFont],
  [Datatype.SLUG, FaFont],
  [Datatype.MARKDOWN, FaMarkdown],
  [Datatype.ATOMIC_URL, FaArrowUpRightFromSquare],
  [Datatype.INTEGER, FaHashtag],
  [Datatype.FLOAT, FaHashtag],
  [Datatype.RESOURCEARRAY, FaListUl],
  [Datatype.BOOLEAN, FaRegSquareCheck],
  [Datatype.DATE, FaCalendar],
  [Datatype.TIMESTAMP, FaClock],
  [Datatype.URI, FaLink],
  [Datatype.JSON, FaCode],
  [Datatype.LOCALIZEDTEXT, FaLanguage],
]);
