import 'package:atomic_flutter/atomic_flutter.dart'
    show AppColorsExt, SectionHeaderStyle;
import 'package:flutter/material.dart';

import 'app_shell.dart';
import 'app_sidebar_icons.dart';
import 'models.dart';
import 'row_leading.dart';
import 'sidebar_metrics.dart';

/// The class icons of the web app's sidebar (`react-icons/fa6`, through
/// `getIconForClass`): Font Awesome Free 6 solid glyphs, from the subset fonts
/// in `fonts/` (icons CC BY 4.0, fonts SIL OFL 1.1, fontawesome.com).
abstract final class ClassIcons {
  static const _s = 'FaSolid';
  static const _b = 'FaBrands';
  static const _p = 'atomic_chat';

  static const folder = IconData(0xf07b, fontFamily: _s, fontPackage: _p);
  static const book = IconData(0xf02d, fontFamily: _s, fontPackage: _p);
  static const comment = IconData(0xf075, fontFamily: _s, fontPackage: _p);
  static const document = IconData(0xf15c, fontFamily: _s, fontPackage: _p);
  static const video = IconData(0xf03d, fontFamily: _s, fontPackage: _p);
  static const file = IconData(0xf15b, fontFamily: _s, fontPackage: _p);
  static const drive = IconData(0xf0a0, fontFamily: _s, fontPackage: _p);
  static const plugin = IconData(0xf12e, fontFamily: _s, fontPackage: _p);
  static const commit = IconData(0xf017, fontFamily: _s, fontPackage: _p);
  static const list = IconData(0xf03a, fontFamily: _s, fontPackage: _p);
  static const cls = IconData(0xf1b2, fontFamily: _s, fontPackage: _p);
  static const table = IconData(0xf0ce, fontFamily: _s, fontPackage: _p);
  static const dashboard = IconData(0xf201, fontFamily: _s, fontPackage: _p);
  static const property = IconData(0x23, fontFamily: _s, fontPackage: _p);
  static const ontology = IconData(0xf61f, fontFamily: _s, fontPackage: _p);
  static const tag = IconData(0xf02b, fontFamily: _s, fontPackage: _p);
  static const canvas = IconData(0xf1fc, fontFamily: _s, fontPackage: _p);
  static const pluginScript = IconData(0xf1e6, fontFamily: _s, fontPackage: _p);
  static const app = IconData(0xf58d, fontFamily: _s, fontPackage: _p);
  static const website = IconData(0xf0ac, fontFamily: _s, fontPackage: _p);
  static const atom = IconData(0xf5d2, fontFamily: _s, fontPackage: _p);
  static const invite = IconData(0xf14d, fontFamily: _s, fontPackage: _p);
  static const form = IconData(0xf298, fontFamily: _b, fontPackage: _p);
}

/// A drive's icon: the web app's hard drive, not a folder.
const driveIcon = ClassIcons.drive;

/// The icon of a class, by the class's name as the rows carry it (the class's
/// own name, or the last part of its subject): the web app's glyph
/// ([ClassIcons]), the atom for a class it does not know, a document when
/// there is no class at all.
IconData iconForClass(String className) {
  final key = className
      .split('/')
      .last
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]'), '');
  return switch (key) {
    'folder' => ClassIcons.folder,
    'drive' => driveIcon,
    'document' || 'documentv2' || '' => ClassIcons.document,
    'table' => ClassIcons.table,
    'canvas' => ClassIcons.canvas,
    // The web app's own sparkle (`AIIcon`); Font Awesome has none like it.
    'aichat' => Icons.auto_awesome,
    'conversation' || 'chatroom' => ClassIcons.comment,
    'meeting' => ClassIcons.video,
    'class' => ClassIcons.cls,
    'property' => ClassIcons.property,
    'ontology' => ClassIcons.ontology,
    'form' => ClassIcons.form,
    'bookmark' => ClassIcons.book,
    'file' => ClassIcons.file,
    'dashboard' => ClassIcons.dashboard,
    'tag' => ClassIcons.tag,
    'plugin' || 'installation' => ClassIcons.plugin,
    'pluginscript' => ClassIcons.pluginScript,
    'websiteproject' => ClassIcons.website,
    'app' => ClassIcons.app,
    'collection' => ClassIcons.list,
    'commit' => ClassIcons.commit,
    'invite' => ClassIcons.invite,
    _ => ClassIcons.atom,
  };
}

const _classLabels = {
  'document': 'Document',
  'documentv2': 'Document',
  'table': 'Table',
  'folder': 'Folder',
  'drive': 'Drive',
  'chatroom': 'Chat',
  'conversation': 'Chat',
  'meeting': 'Meeting',
  'aichat': 'AI chat',
  'chatlog': 'AI chat',
  'canvas': 'Canvas',
  'bookmark': 'Bookmark',
  'file': 'File',
  'dashboard': 'Dashboard',
  'tag': 'Tag',
  'class': 'Class',
  'property': 'Property',
  'ontology': 'Ontology',
  'formfield': 'Form field',
  'form': 'Form',
  'message': 'Message',
  'article': 'Article',
  'agent': 'Agent',
};

/// A class as a person reads it: [className] is a shortname (`document-v2`)
/// or a class URL; a known class gets its label (`Document`), any other the
/// shortname without a version suffix, hyphens and underscores as spaces and
/// a capital (`web-page-v3` -> `Web page`).
String classLabel(String className) {
  var name = className
          .trim()
          .split(RegExp(r'[/#]'))
          .where((p) => p.isNotEmpty)
          .lastOrNull ??
      '';
  if (name.isEmpty) return '';
  final known =
      _classLabels[name.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '')];
  if (known != null) return known;
  name = name
      .replaceFirst(RegExp(r'[-_ ]?v\d+$', caseSensitive: false), '')
      .replaceAll(RegExp(r'[-_]+'), ' ')
      .replaceAllMapped(RegExp(r'([a-z0-9])([A-Z])'), (m) => '${m[1]} ${m[2]}')
      .trim()
      .toLowerCase();
  return name.isEmpty ? '' : name[0].toUpperCase() + name.substring(1);
}

/// One line of a list of resources: the resource's own [emoji] or else an icon
/// if it has one, a title, a line of detail.
class ResourceRow extends StatelessWidget {
  final IconData? icon;

  /// The resource's own icon; shown instead of [icon] when set.
  final String? emoji;
  final String title;
  final String? detail;

  /// A caption of its own (avatars, icons), shown instead of [detail].
  final Widget? detailWidget;

  /// Null for a row that is only information.
  final VoidCallback? onTap;

  /// Shown at the end of the line, e.g. a check mark for a selected row.
  final Widget? trailing;

  /// What the row opens. Next to the detail pane (the split layout of the
  /// shell) the row is marked while that is the resource shown there.
  final String? subject;

  /// The row's own picture (see [RowLeading]); shown instead of [icon], and
  /// before [emoji] when it loads.
  final ImageSource? image;

  /// People and chats are circles, resources rounded squares.
  final RowShape shape;

  /// Fall back to the title's initial (people) instead of [icon].
  final bool showInitial;

  /// The name the initial comes from; the title by default.
  final String? label;

  /// The tree level (compact sidebar rows indent by it).
  final int depth;

  const ResourceRow({
    super.key,
    this.subject,
    this.icon,
    this.emoji,
    required this.title,
    this.detail,
    this.detailWidget,
    this.onTap,
    this.trailing,
    this.image,
    this.shape = RowShape.square,
    this.showInitial = false,
    this.label,
    this.depth = 0,
  });

  bool get _hasEmoji => emoji != null && emoji!.isNotEmpty;

  bool _hasLeading(BuildContext context) =>
      // "Show icons in the sidebar" off: text only, starting at the row inset.
      SidebarIconsScope.of(context) &&
      (icon != null || _hasEmoji || (image != null && !image!.isEmpty));

  /// The leading slot is [SidebarMetrics.iconSlot] wide for every kind of row, so rows line up and
  /// their text starts at the same x.
  Widget? _leading(BuildContext context) {
    if (!_hasLeading(context)) return null;
    final img = image;
    final source = img == null
        ? (_hasEmoji ? ImageSource.emoji(emoji!) : null)
        : ImageSource(
            bytes: img.bytes,
            file: img.file,
            url: img.url,
            data: img.data,
            baseUrl: img.baseUrl,
            emoji: _hasEmoji ? emoji : img.emoji);
    final m = SidebarMetrics.of(context);
    return RowLeading(
      size: m.iconSlot,
      iconSize: m.compact ? m.iconSize : 20,
      cornerRadius: m.compact ? 4 : 8,
      image: source,
      fallbackLabel: label ?? title,
      fallbackIcon: icon ?? ClassIcons.document,
      shape: shape,
      showInitial: showInitial,
      // The touch rows' icons start where avatars and pictures do (and the
      // panel headings' titles); the compact rows centre them in a slot
      // that is as wide as they are.
      alignGlyphStart: !m.compact,
    );
  }

  Widget _tile(BuildContext context, {bool selected = false}) {
    final c = context.appColors;
    // Three levels: the item's title (full text colour), its caption (muted,
    // 4.5:1 or better), under the section header (bold, on a band).
    final titleColor = selected ? c.mainSelectedFg : c.textPrimary;
    final captionColor = selected ? c.mainSelectedFg : c.textSecondary;
    final m = SidebarMetrics.of(context);
    if (m.compact) {
      // Desktop sidebar: one tight line on the shared grid; the caption
      // becomes the tooltip.
      return SidebarRow(
        depth: depth,
        icon: _leading(context),
        title: title,
        titleStyle: SidebarRow.text(titleColor, m.textSize),
        tooltip: detail,
        trailing: trailing,
        selected: selected,
        onTap: onTap,
      );
    }
    return ListTile(
      contentPadding:
          EdgeInsetsDirectional.only(start: m.hPad, end: m.hPad),
      minLeadingWidth: m.iconSlot,
      horizontalTitleGap: m.gap,
      leading: _leading(context),
      title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
      titleTextStyle: TextStyle(
          color: titleColor, fontSize: 15, fontWeight: FontWeight.w400),
      subtitle: detailWidget ??
          (detail == null || detail!.isEmpty ? null : Text(detail!)),
      subtitleTextStyle: TextStyle(color: captionColor, fontSize: 13),
      // A plain list of titles reads better tight.
      visualDensity:
          detail == null && detailWidget == null && !_hasLeading(context)
              ? VisualDensity.compact
              : VisualDensity.standard,
      trailing: trailing,
      selected: selected,
      selectedTileColor: c.rowHighlight,
      selectedColor: c.mainSelectedFg,
      onTap: onTap,
    );
  }

  @override
  Widget build(BuildContext context) {
    final subject = this.subject;
    final shell = ShellScope.maybeOf(context);
    final Widget row;
    if (subject == null ||
        shell == null ||
        ShellScope.layoutOf(context) != ShellLayout.split) {
      row = _tile(context);
    } else {
      row = ValueListenableBuilder<String?>(
        valueListenable: shell.selected,
        builder: (context, selected, _) =>
            _tile(context, selected: selected == subject),
      );
    }
    final warm = shell?.warm;
    if (subject == null || onTap == null || warm == null) return row;
    // The page's first read starts as the finger goes down, not after the
    // tap and the page's first frame (a scroll just leaves it unused).
    return Listener(
      onPointerDown: (_) => warm.prefetch(subject),
      child: row,
    );
  }
}

/// How a row of [className] shows [picture] and [emoji]: the image, the
/// shape (agents, DMs and groups are circles), whether the initial is the
/// fallback, and the generic icon.
({ImageSource? image, RowShape shape, bool initial, IconData icon}) leadingOf(
    ResourcePicture? picture, String? emoji, String className) {
  final key = className.split('/').last.toLowerCase();
  final person = picture?.person == true || key == 'agent';
  final group = picture?.group == true;
  return (
    image: ImageSource.of(picture, emoji: emoji),
    shape: person || group || key == 'conversation' || key == 'chatroom'
        ? RowShape.circle
        : RowShape.square,
    initial: person,
    icon: group ? Icons.groups_outlined : iconForClass(className),
  );
}
