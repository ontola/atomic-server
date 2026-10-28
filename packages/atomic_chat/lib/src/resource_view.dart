import 'package:atomic_flutter/atomic_flutter.dart' show ErrorText;
import 'dart:async';
import 'dart:convert';

import 'package:atomic_flutter/atomic_flutter.dart' show AppColorsExt, Perf;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'app_top_bar.dart';
import 'slide_back_route.dart';
import 'app_shell.dart';
import 'app_sidebar_icons.dart';
import 'app_theme.dart';
import 'assistant_api.dart';
import 'chat_screen.dart';
import 'conversation_screen.dart';
import 'embed_server.dart';
import 'follow_controller.dart';
import 'live_meeting_banner.dart';
import 'meeting_lead.dart';
import 'models.dart';
import 'native_views.dart';
import 'page_swipe.dart';
import 'presence_facepile.dart';
import 'resource_chrome.dart';
import 'warm_resource_web_view.dart';

/// A resource as the web app draws it, without the web app around it: the
/// bundled renderer (`assets/embed`) in a web view, reading from this device's
/// store through a JavaScript channel. No server, no sign-in, no second copy of
/// the data in the page.
class ResourceView extends StatefulWidget {
  final AssistantApi api;
  final String drive;
  final String subject;
  final String title;

  /// A route of the web app to show instead of a resource (`/app/settings`).
  /// Then [subject] may be empty.
  final String? path;

  /// Where the bundled page comes from. A test swaps it for one that fails
  /// fast instead of starting a real server.
  static Future<EmbedServer> Function() serverFactory = EmbedServer.instance;

  /// The page itself. A test swaps in a fake that needs no web view: it gets
  /// the function the page's messages go to.
  @visibleForTesting
  static EmbedPage Function(void Function(String message) onMessage)?
      pageFactory;

  /// How long leaving waits for the page to hand over its last edits.
  @visibleForTesting
  static Duration flushTimeout = const Duration(seconds: 2);

  /// How long a closed page is kept (answering the store's last calls)
  /// before its web view is released.
  @visibleForTesting
  static Duration releaseDelay = const Duration(seconds: 3);

  /// How long the page's placeholder ([ResourceSkeleton]) may stay at most
  /// when the page never says it shows the resource: a warm page that was
  /// told to open it, and a cold one from its start (it loads the bundle).
  @visibleForTesting
  static Duration revealWarm = const Duration(milliseconds: 2000);
  @visibleForTesting
  static Duration revealCold = const Duration(seconds: 8);

  /// The placeholder's fade when the page shows the resource.
  static const revealFade = Duration(milliseconds: 90);

  /// Answers one call of the page. Replaceable in a test.
  final Future<String> Function(String method, String argsJson)? call;

  /// Set (the "more" button's rectangle, in the screen's coordinates) when
  /// this is not the resource but only its menu: the web app's own
  /// `ResourceContextMenu` on a transparent page, over a native screen (see
  /// [showResourceMenu]).
  final Rect? menuAnchor;

  const ResourceView({
    super.key,
    required this.api,
    required this.drive,
    this.subject = '',
    this.title = '',
    this.path,
    this.call,
    this.menuAnchor,
  });

  @override
  State<ResourceView> createState() => _ResourceViewState();
}

const _readMethods = {
  'getResource',
  'getResourcesWithSnapshots',
  'getLoroSnapshot',
  'query',
  'search',
  'allSubjects',
  'getDriveSubjects',
  'getVersionVectorsForDrive',
  'getVersionVectorsForSubjects',
  'getAllVersionVectors',
  'historyAttribution',
  'getBlob',
  'init',
  'agent',
};

/// What the screen needs of the page: run a script in it, and show it.
abstract class EmbedPage {
  Future<void> runJavaScript(String script);
  Future<Object> runJavaScriptReturningResult(String script);
  Widget build();
}

class _ResourceViewState extends State<ResourceView>
    with WidgetsBindingObserver {
  EmbedPage? _page;
  Object? _error;
  final _clock = Stopwatch()..start();
  bool _firstRead = true;
  ShellController? _shell;
  Route<dynamic>? _route;
  bool _leaving = false;

  /// Only the resource's menu, on a transparent page (until an action opens a
  /// page of its own: then this is an ordinary page).
  late bool _menuOnly = widget.menuAnchor != null;

  /// The web page's id for this showing of the menu.
  final _menuId = '${DateTime.now().microsecondsSinceEpoch}';
  bool _wasCurrent = true;

  /// The page that last announced itself on the presence channel. A page
  /// only takes its announcement back when it is still the one standing: the
  /// next page announces before this one is gone.
  static _ResourceViewState? _announcer;

  PresenceWatch? _watch;
  late final FollowController _follow;

  /// The meeting this device leads (the app's, see [MeetingLead]); announced
  /// as the entry's `session` and pushed into the page as its active meeting.
  late final MeetingLead _lead;

  /// What the web page owns of this device's presence entry (`presence` from
  /// the page): the cursor of its view, the thread being typed in, the
  /// meeting it leads. Merged into every announcement; the app keeps
  /// `resource` and `following`.
  Object? _pageData;
  String? _pageTyping;
  String? _pageSession;

  /// The last list and follow state pushed into the page, so an unchanged
  /// read does not wake it.
  String? _pushedPresence;
  String? _pushedFollow;
  String? _pushedMeeting;

  /// The avatar sheet is open: it covers this page without leaving it.
  bool _sheetOpen = false;

  /// The page is being replaced by the one a followed agent opened; that is
  /// not leaving by hand, so following goes on.
  bool _replacing = false;
  int _flushes = 0;

  /// A flush got no answer: the page may hold edits, so it is not reused.
  bool _flushTimedOut = false;
  final _flushed = <int, Completer<void>>{};

  /// Pages that were closed while handing over their last edits: kept here
  /// (and answered) until they are done, so a close never cuts an edit off.
  static final _closing = <EmbedPage>{};

  /// Whether the web view is shown. Until then a [ResourceSkeleton] in the
  /// page's colours covers it (the resource's title where the page's header
  /// will be), never a black box or a spinner: a page that was told to open
  /// a resource first shows the last one, or its own loading state.
  bool _revealed = true;

  /// The placeholder is gone (faded out).
  bool _skeletonGone = true;

  /// The page painted its own header for this resource: the placeholder
  /// covers only what is under it from then on.
  bool _headerShown = false;

  /// What the app knows of the resource before the page has read it, for the
  /// page's breadcrumb (`setCrumbHint` in `BreadCrumbs.tsx`): the row's title
  /// and the drive it was tapped in.
  Map<String, String> get _crumbHint => {
        if (widget.title.isNotEmpty) 'title': widget.title,
        if (widget.drive.isNotEmpty && widget.subject != widget.drive) ...{
          'parent': widget.drive,
          if (knownDriveNames[driveKey(widget.drive)] case final name?)
            'parentTitle': name,
        },
      };
  Timer? _revealCap;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _follow = ShellScope.maybeOf(context)?.follow ?? FollowController();
    _follow.addListener(_followChanged);
    _lead = ShellScope.maybeOf(context)?.lead ?? MeetingLead();
    _lead.addListener(_leadChanged);
    AppSidebarIcons.show.addListener(_tellSidebarIcons);
    _changes = widget.api.resourceChanges?.listen(_tellChanged);
    widget.api.storeChanges?.addListener(_storeChanged);
    // A resource page in a real web view starts covered; a page of the app's
    // own (settings) and a test's page do not.
    if (widget.path == null && !_menuOnly) {
      _revealed = false;
      _skeletonGone = false;
      _revealCap = Timer(ResourceView.revealCold, _reveal);
    }
    _start();
    // The route is known once this is in the tree.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _registerMenu();
        _showPresence();
      }
    });
  }

  /// The shell's warm pool, which may hold a read started on the row's
  /// pointer-down ([WarmResourceWebView.prefetch]).
  WarmResourceWebView? _pool;

  Future<void> _start() async {
    // A page loaded ahead by the shell, when there is one: no page load.
    final pool = _pool = ShellScope.maybeOf(context)?.warm;
    if (pool != null && widget.path == null && widget.subject.isNotEmpty) {
      final warm = pool.take();
      if (warm != null) {
        _attach(warm, warm: true);
        return;
      }
    }
    final fake = ResourceView.pageFactory;
    if (fake != null) {
      _page = fake(_onMessage);
      if (_menuOnly) _showMenuWhenLaidOut(_page!);
      // Only a page that can say it shows the resource is covered.
      if (_page is! WarmPage) {
        _revealCap?.cancel();
        _revealed = _skeletonGone = true;
      }
      return;
    }
    try {
      final server = await ResourceView.serverFactory();
      if (!mounted) return;
      final scheme =
          Theme.of(context).brightness == Brightness.dark ? 'dark' : 'light';
      final page = await WebViewEmbedPage.create(
        server.page.replace(queryParameters: {
          if (_menuOnly)
            'path': '/app/show?subject=${Uri.encodeComponent(widget.subject)}'
                '&menu=$_menuId&x=${_menuPoint().dx}&y=${_menuPoint().dy}'
          else if (widget.path != null)
            'path': widget.path!
          else ...{
            'subject': widget.subject,
            'hint': jsonEncode(_crumbHint),
          },
          // The page's first paint is in the app's light or dark mode.
          'scheme': scheme,
          'sidebarIcons': AppSidebarIcons.queryValue,
        }),
        onMessage: _onMessage,
        onLoaded: _pageLoaded,
      );
      if (mounted) {
        setState(() => _page = page);
      } else {
        page.release();
      }
    } catch (e) {
      if (mounted) setState(() => _error = e);
      _reveal();
    }
  }

  /// Watches the page until its `main` shows [ResourceView.subject] with
  /// something in it other than a loading state, then posts `revealed` two
  /// frames later (so it is on screen). Gives up after 1.5 s and posts
  /// anyway: the page then shows its own loading state or an empty view.
  void _watchReveal() {
    if (_revealed || _revealWatched) return;
    _revealWatched = true;
    final subject = jsonEncode(widget.subject);
    final title = jsonEncode(widget.title);
    // Shown once the page's main is the resource's and has its content: no
    // loading status left in it, or its title already painted (a table or
    // board shows its header and rows while a cell or a lazy part still
    // loads; waiting for those kept the placeholder up to the cap). `why`
    // says what it waited on last, for the log.
    unawaited(_page
        ?.runJavaScript('(function(){var s=$subject,n=$title,t=Date.now(),'
            'why="";function done(){requestAnimationFrame(function(){'
            'requestAnimationFrame(function(){AtomicFlutter.postMessage('
            'JSON.stringify({method:"revealed",ms:Date.now()-t,why:why}))})})}'
            'function c(){var all=document.querySelectorAll("main"),m=null;'
            'for(var i=0;i<all.length;i++)if(all[i].getAttribute("about")===s)'
            'm=all[i];var st=m&&m.querySelector("[role=status]");'
            'if(!m)why="no main";else if(m.children.length<2)why="empty main";'
            'else if(st&&!(n&&m.innerText.indexOf(n)>=0))why="status "+'
            '(st.getAttribute("aria-label")||st.textContent||"").slice(0,40);'
            'else{done();return}'
            'if(Date.now()-t>1500){why="cap, "+why;done();return}'
            'setTimeout(c,16)}c()})()')
        .catchError((_) {}));
  }

  bool _revealWatched = false;

  /// The page claimed horizontal drags ([PageSwipe] leaves them alone).
  bool _horizontal = false;

  /// Shows the web view: the placeholder fades out.
  void _reveal() {
    _revealCap?.cancel();
    if (_revealed) return;
    _revealed = true;
    if (_page != null && !kReleaseMode) {
      final path = _warm ? 'warm' : 'cold';
      Perf.span('resource revealed $path', _clock.elapsedMilliseconds);
      Perf.sinceTap('resource revealed $path');
    }
    if (mounted) setState(() {});
  }

  /// Takes a loaded [page] over: its messages come here, it is told the
  /// colour scheme and which resource to show. Everything a view does with
  /// its page is set up here, not when the page is made.
  void _attach(WarmPage page, {required bool warm}) {
    _warm = warm;
    _page = page;
    page.onMessage = _onMessage;
    page.onLoaded = _pageLoaded;
    if (warm) {
      // The page is still in the pool's slot this frame (it is taken while
      // this page builds; the slot lets go after that). Both rebuild in the
      // next frame and the web view moves over, still attached. Nothing is
      // lost: the placeholder covers it for the first frames anyway.
      _inTree = false;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() => _inTree = true);
      });
      debugPrint('[warm] taken ready=${page is WebViewEmbedPage ? page.age : 0}'
          ' ms after it started loading');
      final subject = jsonEncode(widget.subject);
      if (_menuOnly) {
        _showMenuWhenLaidOut(page);
        return;
      }
      // What the spare rendered ahead is read from the store again: it may
      // have changed while the page was hidden.
      final ahead = WarmResourceWebView.shownAhead[page];
      final reload =
          ahead == null ? '' : 'e.changed&&e.changed([${jsonEncode(ahead)}]);';
      // `open` replaces the page's blank first entry, so back leaves the
      // resource; an older bundle only has `show`.
      final hint = jsonEncode(_crumbHint);
      unawaited(page.runJavaScript('(function(e){if(!e)return;$reload'
          '(e.open||e.show)($subject,$hint)})(window.atomicEmbed)'));
      _watchPainted();
      _revealCap?.cancel();
      _revealCap = Timer(ResourceView.revealWarm, _reveal);
      _watchReveal();
    }
  }

  /// Where the menu opens in the page's own coordinates: the button's right
  /// edge and top (the web menu flips itself to fit).
  Offset _menuPoint() {
    final anchor = widget.menuAnchor ?? Rect.zero;
    final box = context.findRenderObject() as RenderBox?;
    final origin = box == null || !box.hasSize
        ? Offset.zero
        : box.localToGlobal(Offset.zero);
    return anchor.topRight - origin;
  }

  /// Tells a loaded page to show only the menu, at the button: once this view
  /// has been laid out, so the web view has its size.
  void _showMenuWhenLaidOut(EmbedPage page) {
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await Future<void>.delayed(const Duration(milliseconds: 120));
      if (!mounted || !_menuOnly) return;
      final at = _menuPoint();
      unawaited(page.runJavaScript('window.atomicEmbed.showMenu('
          '${jsonEncode(widget.subject)},{x:${at.dx},y:${at.dy}})'));
    });
  }

  bool _warm = false;
  int _traced = 0;

  /// Whether this page builds its web view (see [_attach]).
  bool _inTree = true;

  /// Debug and profile builds: `[perf] resource painted` once the page's
  /// main area shows the resource's title (two frames after, so it is on
  /// screen). Without a title, nothing is measured.
  void _watchPainted() {
    if (kReleaseMode || widget.title.isEmpty || _paintWatched) return;
    _paintWatched = true;
    final title = jsonEncode(widget.title);
    // The page also times itself: from this script (a warm page, just told
    // to open) or from its own load (cold), to the frame that shows the
    // title. That excludes getting the message to the app, which on the
    // emulator waits for the web view's GL frames.
    final since = _warm ? 'Date.now()' : 'Date.now()-performance.now()';
    unawaited(_page
        ?.runJavaScript('(function(){var t0=$since,s=Date.now();function c(){'
            'var m=document.querySelector("main");'
            'if(m&&m.innerText.indexOf($title)>=0){requestAnimationFrame('
            'function(){requestAnimationFrame(function(){'
            'AtomicFlutter.postMessage(JSON.stringify({method:"painted",'
            'ms:Date.now()-t0}))})});return}'
            'if(Date.now()-s<20000)setTimeout(c,16)}c()})()')
        .catchError((_) {}));
  }

  bool _paintWatched = false;

  void _pageLoaded() {
    _watchPainted();
    _watchReveal();
    debugPrint('[embed] page loaded after ${_clock.elapsedMilliseconds} ms');
    // The page follows the app's light/dark mode for its own 'auto'.
    _scheme = null;
    _icons = null;
    if (mounted) _tellColorScheme();
  }

  /// The bar's last button becomes this resource's "more" menu (the web app's
  /// navbar menu, drawn by the page) while this page is the one on top. A
  /// `path` page (settings) has no resource and no menu.
  void _registerMenu() {
    final route = ModalRoute.of(context);
    if (route == null) return;
    if (_menuOnly) return;
    _route = route;
    // A swipe back slides the page out, then waits for its last edits.
    if (route is SlideBackRoute) route.beforeSwipeLeave = _flushLeaving;
    if (widget.path != null) return;
    final shell = ShellScope.maybeOf(context);
    if (shell == null) return;
    _shell = shell;
    // Until the page has loaded there is nothing to open: the tap does
    // nothing.
    shell.registerMenu(route, (anchor) {
      // The page's own coordinates: its right edge is the button's.
      final box = context.findRenderObject() as RenderBox?;
      final at = box == null || !box.hasSize
          ? anchor
          : anchor.shift(-box.localToGlobal(Offset.zero));
      _page?.runJavaScript(
          'window.atomicEmbed?.openMenu({x:${at.right},y:${at.top}})');
    });
  }

  /// The app's light/dark mode as the page last heard it.
  String? _scheme;

  /// "Show icons in the sidebar" as the page last heard it.
  bool? _icons;

  void _tellSidebarIcons() {
    final show = AppSidebarIcons.show.value;
    if (show == _icons || _page == null) return;
    _icons = show;
    unawaited(
        _page!.runJavaScript('window.atomicEmbed?.setSidebarIcons?.($show)'));
  }

  void _tellColorScheme() {
    _tellSidebarIcons();
    final scheme =
        Theme.of(context).brightness == Brightness.dark ? 'dark' : 'light';
    if (scheme == _scheme || _page == null) return;
    _scheme = scheme;
    unawaited(_page!
        .runJavaScript("window.atomicEmbed?.setColorScheme?.('$scheme')"));
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _tellColorScheme();
    // Another page was opened over this one (search, a linked resource):
    // this one may never be shown again, so its edits go now.
    if (_sheetOpen) return;
    final current = ModalRoute.of(context)?.isCurrent ?? true;
    if (_wasCurrent && !current && !_leaving) unawaited(_flush());
    if (_wasCurrent && !current) {
      _hidePresence();
      // Opening something else by hand ends following, as on the web.
      if (!_replacing) _follow.stop();
    } else if (!_wasCurrent && current) {
      _showPresence();
    }
    _wasCurrent = current;
  }

  /// Whether this is a resource page others can see us on (not the resource's
  /// menu, not a page of the app's own such as settings).
  bool get _announces =>
      widget.path == null && !_menuOnly && widget.subject.isNotEmpty;

  /// This page is on top: tell the drive which resource it is, and watch who
  /// else has it open.
  void _showPresence() {
    if (!_announces || _leaving || !mounted) return;
    if (ModalRoute.of(context)?.isCurrent == false) return;
    _announcer = this;
    final watch = _watch ??= PresenceWatch(widget.api, widget.drive)
      ..addListener(_watchChanged);
    watch.start();
    _announce();
    _trail();
    _pushPresence(force: true);
    setState(() {});
  }

  void _announce() {
    widget.api
        .announcePresence(widget.drive,
            resource: widget.subject,
            following: _follow.agent,
            session: _lead.meetingIn(widget.drive) ?? _pageSession,
            extra: {
              if (_pageData != null) 'data': _pageData,
              if (_pageTyping != null) 'typing': _pageTyping,
            })
        .catchError((Object e) => debugPrint('[presence] not announced: $e'));
  }

  void _watchChanged() {
    _pushPresence();
    _leaderMoved();
  }

  /// Hands the page the others in the drive and who the app follows, so its
  /// facepiles, cursors and follow controls show what the app knows (the page
  /// has no connection of its own). [force]: even when nothing changed since
  /// the last push (the page was just shown, or loaded after the last one).
  void _pushPresence({bool force = false}) {
    final page = _page;
    final watch = _watch;
    if (page == null || watch == null || _announcer != this || _menuOnly) {
      return;
    }
    final items = jsonEncode([for (final i in watch.items) i.toJson()]);
    if (force || items != _pushedPresence) {
      _pushedPresence = items;
      unawaited(page
          .runJavaScript('window.atomicEmbed?.presence('
              '${jsonEncode(widget.drive)},$items)')
          .catchError((Object _) {}));
    }
    _pushFollow(force: force);
    _pushMeeting(force: force);
  }

  /// Tells the page which meeting this device leads on its drive (null:
  /// none), so its Start / End buttons and `activeMeeting` follow the app.
  void _pushMeeting({bool force = false}) {
    final page = _page;
    if (page == null || _announcer != this || _menuOnly) return;
    final meeting = jsonEncode(_lead.meetingIn(widget.drive));
    if (!force && meeting == _pushedMeeting) return;
    _pushedMeeting = meeting;
    unawaited(page
        .runJavaScript('window.atomicEmbed?.setMeeting($meeting)')
        .catchError((Object _) {}));
  }

  /// The meeting changed (started, ended, or read back after a restart): the
  /// entry says so, the page hears it, and the page shown is trailed.
  void _leadChanged() {
    if (_lead.meetingIn(widget.drive) == null) _pageSession = null;
    if (_announcer == this) {
      _announce();
      _trail();
    }
    _pushMeeting();
    if (mounted) setState(() {});
  }

  /// While this device leads a meeting, the page now shown goes in the
  /// meeting's chat as a "Viewing [title](subject)" line, once per resource
  /// per meeting (the web's `postTrailMessage`). The page does not post it
  /// when embedded: the app does.
  void _trail() {
    final meeting = _lead.meetingIn(widget.drive);
    if (meeting == null || _announcer != this || !_announces) return;
    if (!_lead.markTrailed(widget.subject)) return;
    final title = widget.title.trim().isEmpty ? widget.subject : widget.title;
    widget.api
        .sendChatRoomMessage(meeting, 'Viewing [$title](${widget.subject})')
        .catchError((Object e) => debugPrint('[meeting] trail not posted: $e'));
  }

  /// Join on the live meeting strip: follow the leader and open the meeting.
  /// Following goes on from there (the leader's page replaces it).
  void _joinLive(LiveMeeting live) {
    _follow.follow(live.leader.agent, session: live.leader.sessionId);
    if (live.meeting == widget.subject) {
      _leaderMoved();
      return;
    }
    _replacing = true;
    widget.api.noteOpened(widget.drive, live.meeting);
    final split = ShellScope.maybeOf(context)?.split ?? false;
    unawaited(Navigator.of(context).pushReplacement(SlideBackRoute<void>(
      instant: split,
      builder: (_) => openResourceView(
          api: widget.api, drive: widget.drive, subject: live.meeting),
    )));
  }

  void _pushFollow({bool force = false}) {
    final page = _page;
    if (page == null || _announcer != this || _menuOnly) return;
    final agent = jsonEncode(_follow.agent);
    if (!force && agent == _pushedFollow) return;
    _pushedFollow = agent;
    unawaited(page
        .runJavaScript('window.atomicEmbed?.setFollow($agent)')
        .catchError((Object _) {}));
  }

  /// The page's `presence` call: the fields it owns of the entry. Only the
  /// fields it names change; a null clears one.
  void _pagePresence(Object? args) {
    final fields = args is List && args.isNotEmpty ? args.first : null;
    if (fields is! Map) return;
    var changed = false;
    if (fields.containsKey('data') && fields['data'] != _pageData) {
      _pageData = fields['data'];
      changed = true;
    }
    if (fields.containsKey('typing')) {
      final typing = fields['typing'];
      final next = typing is String && typing.isNotEmpty ? typing : null;
      if (next != _pageTyping) {
        _pageTyping = next;
        changed = true;
      }
    }
    if (fields.containsKey('session')) {
      final session = fields['session'];
      final next = session is String && session.isNotEmpty ? session : null;
      if (next != _pageSession) {
        _pageSession = next;
        changed = true;
      }
    }
    if (changed && _announcer == this) _announce();
  }

  /// This page is no longer shown: the entry keeps who we follow but no
  /// resource. Only when no other page took the announcement over meanwhile.
  void _hidePresence({bool background = false}) {
    _watch?.stop();
    if (_announcer != this) return;
    _announcer = null;
    final drive = widget.drive;
    (background
            ? widget.api.clearPresence(drive)
            : widget.api.announcePresence(drive,
                following: _follow.agent, session: _lead.meetingIn(drive)))
        .catchError((Object e) => debugPrint('[presence] not cleared: $e'));
  }

  /// Following started or stopped: the entry says so.
  void _followChanged() {
    if (_announcer == this) _announce();
    _pushFollow();
    if (mounted) setState(() {});
  }

  /// The watched presence changed: while following, go where the leader is.
  void _leaderMoved() {
    final leader = _follow.agent;
    if (leader == null || _announcer != this || _replacing) return;
    final items = _watch!.items.where((i) => i.agent == leader).toList();
    if (items.isEmpty) {
      // They left the drive.
      _follow.stop();
      return;
    }
    // The followed session, else (it went away) their freshest one.
    final target =
        (items.where((i) => i.sessionId == _follow.session).firstOrNull ??
                items.reduce((a, b) => b.updatedAt > a.updatedAt ? b : a))
            .resource;
    if (target == null || target == widget.subject) return;
    _replacing = true;
    widget.api.noteOpened(widget.drive, target);
    final split = ShellScope.maybeOf(context)?.split ?? false;
    // Replace, not stack: back still leaves following.
    unawaited(Navigator.of(context).pushReplacement(SlideBackRoute<void>(
      instant: split,
      builder: (_) => openResourceView(
          api: widget.api, drive: widget.drive, subject: target),
    )));
  }

  /// A tap on an avatar of the facepile.
  Future<void> _avatarTapped(PresenceItem who) async {
    final watch = _watch!;
    final identity = watch.identity(who.agent);
    // Message only where a conversation can be opened.
    final conversation = await widget.api
        .conversationWith(who.agent)
        .catchError((Object _) => null);
    if (!mounted) return;
    _sheetOpen = true;
    PresenceChoice? choice;
    try {
      choice = await showPresenceSheet(context,
          who: who,
          identity: identity,
          following: _follow.isFollowing(who.agent),
          canMessage: conversation != null);
    } finally {
      _sheetOpen = false;
    }
    if (!mounted || choice == null) return;
    switch (choice) {
      case PresenceChoice.follow:
        _follow.follow(who.agent, session: who.sessionId);
        // Go to where they are right away.
        _leaderMoved();
      case PresenceChoice.stopFollowing:
        _follow.stop();
      case PresenceChoice.profile:
        debugPrint('[presence] opening the profile ${who.agent}');
        unawaited(Navigator.of(context).push(SlideBackRoute<void>(
          builder: (_) => openResourceView(
              api: widget.api,
              drive: widget.drive,
              subject: who.agent,
              title: identity?.name?.trim() ?? ''),
        )));
      case PresenceChoice.message:
        if (conversation == null) return;
        unawaited(Navigator.of(context).push(SlideBackRoute<void>(
          builder: (_) => ConversationScreen(
              api: widget.api,
              drive: widget.drive,
              subject: conversation,
              title: identity?.name?.trim() ?? ''),
        )));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The app going to the background may be the last the page gets to run.
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused) {
      unawaited(_flush());
      _hidePresence(background: true);
    } else if (state == AppLifecycleState.resumed && _wasCurrent) {
      _showPresence();
    }
  }

  StreamSubscription<List<String>>? _changes;

  /// Another device changed resources: the page merges what it shows of them,
  /// so an open document follows the other device's edits live.
  void _tellChanged(List<String> subjects) {
    if (_menuOnly) return;
    unawaited(_page
        ?.runJavaScript('window.atomicEmbed?.changed(${jsonEncode(subjects)})')
        .catchError((Object _) {}));
  }

  /// A sync that tells no subjects (a server's) may have changed this one.
  void _storeChanged() {
    if (widget.subject.isNotEmpty) _tellChanged([widget.subject]);
  }

  @override
  void dispose() {
    _revealCap?.cancel();
    unawaited(_changes?.cancel());
    widget.api.storeChanges?.removeListener(_storeChanged);
    WidgetsBinding.instance.removeObserver(this);
    _hidePresence();
    _watch?.dispose();
    _follow.removeListener(_followChanged);
    _lead.removeListener(_leadChanged);
    // Left by hand (a swipe back, the system back), not replaced by follow.
    // (After the tree is torn down: other pages listen to it.)
    if (!_replacing) scheduleMicrotask(_follow.stop);
    AppSidebarIcons.show.removeListener(_tellSidebarIcons);
    final route = _route;
    if (route != null) _shell?.unregisterMenu(route);
    if (route is SlideBackRoute && route.beforeSwipeLeave == _flushLeaving) {
      route.beforeSwipeLeave = null;
    }
    // Closed without going through [_leave] (the route was removed from
    // under it): hand over what is left, keeping the page until it has.
    final page = _page;
    if (!_leaving && page != null) {
      _closing.add(page);
      unawaited(_flush(leaving: true).whenComplete(() {
        _closing.remove(page);
        _release(page);
      }));
    } else if (page != null) {
      _release(page);
    }
    super.dispose();
  }

  /// Drops the web view a little later: the store may still be answering the
  /// page's last calls.
  void _release(EmbedPage page) {
    // A page that loaded fine and handed over its edits goes back to the pool
    // as its spare: the next open of a resource is then warm.
    final pool = _pool;
    if (pool != null &&
        page is WarmPage &&
        _error == null &&
        !_menuOnly &&
        widget.path == null &&
        widget.subject.isNotEmpty &&
        !_flushTimedOut &&
        pool.giveBack(page, subject: widget.subject)) {
      return;
    }
    final releasable = page is ReleasablePage ? page as ReleasablePage : null;
    if (releasable == null) return;
    Future<void>.delayed(ResourceView.releaseDelay, releasable.release);
  }

  /// Asks the page to hand every pending edit to the store
  /// (`window.atomicEmbed.flush`), and waits for its answer: a `flushed`
  /// message, as `runJavaScript` does not wait for a promise. Gives up after
  /// [ResourceView.flushTimeout], so leaving never hangs on the page.
  Future<void> _flush({bool leaving = false}) {
    final page = _page;
    if (page == null) return Future.value();
    final id = ++_flushes;
    final done = Completer<void>();
    _flushed[id] = done;
    final reply = "AtomicFlutter.postMessage(JSON.stringify("
        "{method:'flushed',flush:$id}))";
    page
        .runJavaScript('Promise.resolve(window.atomicEmbed && '
            'window.atomicEmbed.flush && window.atomicEmbed.flush($leaving))'
            '.catch(function(){}).then(function(){$reply})')
        .catchError((_) {
      if (!done.isCompleted) done.complete();
    });
    return done.future.timeout(ResourceView.flushTimeout, onTimeout: () {
      debugPrint('[embed] flush $id: no answer, leaving anyway');
      _flushTimedOut = true;
    }).whenComplete(() => _flushed.remove(id));
  }

  Future<void> _flushLeaving() {
    _leaving = true;
    return _flush(leaving: true);
  }

  /// A call from the page: `{id, method, args}`. Answered with
  /// `window.__atomicReply(id, ok, payload)`. A `flushed` message answers a
  /// [_flush].
  Future<void> _onMessage(String message) async {
    final request = jsonDecode(message) as Map<String, dynamic>;
    if (request['method'] == 'flushed') {
      final done = _flushed[request['flush']];
      if (done != null && !done.isCompleted) done.complete();
      return;
    }
    if (request['method'] == 'menuState') {
      // The page's menu and its dialogs are done, or an action went to a page.
      if (request['state'] == 'closed') {
        unawaited(_leave());
      } else if (_menuOnly) {
        setState(() => _menuOnly = false);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) {
            _registerMenu();
            _showPresence();
          }
        });
      }
      return;
    }
    if (request['method'] == 'gestures') {
      // The page needs horizontal drags itself (a touch on a canvas, a
      // scrolling table, or a whole page of drawing): no swipe back.
      _horizontal = request['mode'] == 'horizontal';
      return;
    }
    if (request['method'] == 'header') {
      // The page is up: what the app knows of presence and following was
      // pushed before it could listen.
      _pushPresence(force: true);
      if (request['subject'] == widget.subject && !_headerShown && mounted) {
        setState(() => _headerShown = true);
      }
      return;
    }
    if (request['method'] == 'revealed') {
      _pushPresence(force: true);
      final why = request['why'];
      if (why is String && why.isNotEmpty) {
        debugPrint('[warm] revealed after ${request['ms']} ms, waited on $why');
      }
      _reveal();
      return;
    }
    if (request['method'] == 'painted') {
      final path = _warm ? 'warm' : 'cold';
      Perf.span('resource painted $path', _clock.elapsedMilliseconds);
      Perf.sinceTap('resource painted $path');
      Perf.span('resource painted in page $path', request['ms'] as int? ?? -1);
      return;
    }
    final id = request['id'] as int;
    final method = request['method'] as String;
    if (method == 'opened') {
      final args = request['args'];
      if (args is List && args.isNotEmpty) {
        unawaited(_followDrive('${args[0]}'));
      }
    }
    if (method == 'openNative') {
      await _answerOpenNative(id, request['args']);
      return;
    }
    if (method == 'askAssistant') {
      await _answerAskAssistant(id, request['args']);
      return;
    }
    if (method == 'joinCall') {
      await _answerJoinCall(id, request['args']);
      return;
    }
    if (method == 'meetingStarted' || method == 'meetingEnded') {
      // The page started or ended a meeting (its resources are written): the
      // app owns that this device leads it, so it survives this page.
      final args = request['args'];
      final meeting = args is List && args.isNotEmpty && args.first is String
          ? args.first as String
          : '';
      if (meeting.isNotEmpty) {
        if (method == 'meetingStarted') {
          _lead.start(widget.drive, meeting);
        } else {
          _lead.end(meeting);
        }
      }
      try {
        await _page?.runJavaScript(
            'window.__atomicReply($id,true,${jsonEncode('true')})');
      } catch (_) {}
      return;
    }
    if (method == 'presence' || method == 'follow' || method == 'unfollow') {
      // The page's presence fields, and its follow buttons: the app keeps the
      // one follow state and does the navigating (`_leaderMoved`).
      final args = request['args'];
      if (method == 'presence') {
        _pagePresence(args);
      } else if (method == 'unfollow') {
        _follow.stop();
      } else if (args is List && args.isNotEmpty && '${args.first}'.isNotEmpty) {
        _follow.follow('${args.first}');
        // Go to where they are right away.
        _leaderMoved();
      }
      try {
        await _page?.runJavaScript(
            'window.__atomicReply($id,true,${jsonEncode('true')})');
      } catch (_) {}
      return;
    }
    if (method == 'sidebarIcons') {
      // "Show icons in the sidebar", switched on the settings page: the app's
      // Home follows.
      final show = AppSidebarIcons.parse(request['args']);
      if (show != null) {
        _icons = show;
        unawaited(AppSidebarIcons.choose(show));
      }
      try {
        await _page?.runJavaScript(
            'window.__atomicReply($id,true,${jsonEncode('true')})');
      } catch (_) {}
      return;
    }
    if (method == 'theme') {
      // The theme chosen on the settings page: the app's own screens follow.
      final args = request['args'];
      unawaited(AppThemeMode.choose(
          args is List && args.isNotEmpty ? '${args.first}' : ''));
      try {
        await _page?.runJavaScript(
            'window.__atomicReply($id,true,${jsonEncode('true')})');
      } catch (_) {}
      return;
    }
    final started = _clock.elapsedMilliseconds;
    var firstContent = false;
    String reply;
    // Writes show up in logcat, so what the page persists can be followed.
    if (kDebugMode && !_readMethods.contains(method)) {
      debugPrint('[embed] call $method (${message.length} chars)');
    }
    try {
      final args = jsonEncode(_withDrive(method, request['args']));
      final prefetched =
          widget.call == null ? _pool?.takePrefetched(method, args) : null;
      final answer = await (prefetched ??
          (widget.call ?? widget.api.embedCall)(method, args));
      reply = 'true,${jsonEncode(answer)}';
      if (_firstRead && method == 'getResourcesWithSnapshots') {
        _firstRead = false;
        debugPrint('[embed] first read at $started ms, answered in '
            '${_clock.elapsedMilliseconds - started} ms'
            '${prefetched != null ? ' (read on pointer-down)' : ''}');
        debugPrint(_warm
            ? '[warm] open ${_clock.elapsedMilliseconds} ms first content'
            : '[warm] cold open ${_clock.elapsedMilliseconds} ms first content');
        firstContent = true;
      }
    } catch (e) {
      reply = 'false,${jsonEncode('$e')}';
    }
    // Answered after this screen is gone too: a page that is closing still
    // waits on the store (signing, applying its last commit).
    final answered = _clock.elapsedMilliseconds;
    try {
      await _page?.runJavaScript('window.__atomicReply($id,$reply)');
      if (!kReleaseMode && _traced++ < 12) {
        // The first calls of a page, to see where an open spends its time.
        debugPrint('[perf] embed $method in at $started, answered at '
            '$answered, delivered at ${_clock.elapsedMilliseconds} ms '
            '(${reply.length} chars)');
      }
      if (firstContent && !kReleaseMode) {
        Perf.span('resource data ${_warm ? 'warm' : 'cold'}',
            _clock.elapsedMilliseconds);
      }
    } catch (e) {
      debugPrint('[embed] reply to $method not delivered: $e');
    }
  }

  /// The page settled on [subject]: when it is in another of the person's
  /// drives, that drive becomes the current one (the home follows).
  Future<void> _followDrive(String subject) async {
    final shell = ShellScope.maybeOf(context);
    if (shell == null || subject.isEmpty) return;
    try {
      final drive = await driveOfResource(widget.api, subject);
      if (drive == null || driveKey(drive) == driveKey(shell.drive.value)) {
        return;
      }
      final known = await widget.api.drives();
      if (!mounted) return;
      for (final d in known) {
        if (driveKey(d.subject) == driveKey(drive)) {
          shell.drive.value = d.subject;
          return;
        }
      }
    } catch (e) {
      debugPrint('[embed] drive of $subject not followed: $e');
    }
  }

  /// `opened(subject)`: the page settled on a resource (reached by a link, a
  /// folder's child, one just created). The store notes it in this drive's
  /// Recents, so it gets the drive the page is shown in.
  List<Object?> _withDrive(String method, Object? args) {
    final list = args is List ? List<Object?>.of(args) : <Object?>[];
    if (method == 'opened') {
      return [list.isEmpty ? '' : list.first, widget.drive];
    }
    return list;
  }

  /// The page asks to show a resource in the app's own screen
  /// (`openNative(kind, subject, title)`): opened when the app has a native
  /// view for that kind, and the answer says whether it did, so the page draws
  /// the resource itself when not.
  Future<void> _answerOpenNative(int id, Object? args) async {
    var handled = false;
    if (args is List && args.length >= 2) {
      final kind = '${args[0]}';
      final subject = '${args[1]}';
      final title = args.length > 2 ? '${args[2]}' : '';
      if (mounted && subject.isNotEmpty && hasNativeView(kind)) {
        handled = true;
        widget.api.noteOpened(widget.drive, subject);
        unawaited(Navigator.of(context)
            .push(SlideBackRoute<void>(
              builder: (_) => openResourceView(
                  api: widget.api,
                  drive: widget.drive,
                  subject: subject,
                  title: title,
                  classUrl: kind),
            ))
            // The native screen can have changed it (renamed a chat room):
            // the page reads it again.
            .then((_) => _page?.runJavaScript(
                'window.atomicEmbed?.changed(${jsonEncode([subject])})')));
      }
    }
    try {
      await _page?.runJavaScript('window.__atomicReply($id,true,'
          '${jsonEncode(jsonEncode(handled))})');
    } catch (e) {
      debugPrint('[embed] reply to openNative not delivered: $e');
    }
  }

  /// The page asks the assistant (`askAssistant(prompt, subject)`: the "Fix
  /// it" of an app that hit an error, or any of the page's "ask AI" actions):
  /// a new chat opens on top with the prompt as its first message and the
  /// resource it is about attached, and the page is told it was taken.
  Future<void> _answerAskAssistant(int id, Object? args) async {
    var handled = false;
    if (args is List && args.isNotEmpty && args.first is String) {
      var prompt = (args.first as String).trim();
      final subject = args.length > 1 && args[1] is String
          ? (args[1] as String).trim()
          : '';
      if (mounted && prompt.isNotEmpty) {
        handled = true;
        if (subject.isNotEmpty) prompt = '$prompt\n\nAbout: $subject';
        unawaited(Navigator.of(context).push(SlideBackRoute<void>(
          builder: (_) => ChatScreen(
            api: widget.api,
            drive: widget.drive,
            initialPrompt: prompt,
            initialContext: subject.isEmpty
                ? null
                : (
                    subject: subject,
                    title: subject == widget.subject && widget.title.isNotEmpty
                        ? widget.title
                        : subject,
                    className: '',
                    emoji: null
                  ),
          ),
        )));
      }
    }
    try {
      await _page?.runJavaScript('window.__atomicReply($id,true,'
          '${jsonEncode(jsonEncode(handled))})');
    } catch (e) {
      debugPrint('[embed] reply to askAssistant not delivered: $e');
    }
  }

  /// The page asks for the call of a meeting (`joinCall(meeting)`). The call
  /// is not this page's: it is the shell's ([ShellController.call], a web
  /// view of its own shown as a floating tile), so it goes on when this page
  /// is replaced by following the leader. Answers whether the app took it
  /// (not without a shell), and the page hides its call button when not.
  Future<void> _answerJoinCall(int id, Object? args) async {
    final call = ShellScope.maybeOf(context)?.call;
    final meeting = args is List && args.isNotEmpty && args.first is String
        ? args.first as String
        : '';
    var handled = false;
    if (mounted && call != null && meeting.isNotEmpty) {
      handled = true;
      final scheme =
          Theme.of(context).brightness == Brightness.dark ? 'dark' : 'light';
      unawaited(call.start(meeting, scheme: scheme));
    }
    try {
      await _page?.runJavaScript('window.__atomicReply($id,true,'
          '${jsonEncode(jsonEncode(handled))})');
    } catch (e) {
      debugPrint('[embed] reply to joinCall not delivered: $e');
    }
  }

  /// Back goes one page back inside the page first (after an action opened
  /// its form, say), and leaves the resource when there is none.
  Future<void> _back() async {
    if (_leaving) return;
    if (_menuOnly) return _leave();
    final page = _page;
    if (page != null) {
      final went = await page
          .runJavaScriptReturningResult('window.atomicEmbed?.back() === true');
      if ('$went' == 'true' || went == true) return;
    }
    await _leave();
  }

  /// Leaves the resource once the page has handed over its last edits.
  Future<void> _leave() async {
    if (_leaving) return;
    _leaving = true;
    await _flush(leaving: true);
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    final page = _page;
    if (_menuOnly) {
      return PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _back();
        },
        child: Material(
          type: MaterialType.transparency,
          child: page != null && _inTree ? page.build() : const SizedBox(),
        ),
      );
    }
    return PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _back();
        },
        child: Scaffold(
          backgroundColor: c.bgBody,
          // A page of the app's own (settings) has no breadcrumb of a
          // resource, so it gets the title bar of the native screens.
          appBar: widget.path != null && widget.title.isNotEmpty
              ? AppTopBar(title: widget.title)
              : null,
          body: SafeArea(
            bottom: false,
            child: _error != null
                ? Center(child: ErrorText('$_error', color: c.alert))
                : Column(children: [
                    // A meeting is happening in this drive and this device is
                    // not in it: one tap to join.
                    if (_watch != null && _announces)
                      LiveMeetingBanner(
                          api: widget.api,
                          drive: widget.drive,
                          watch: _watch,
                          lead: _lead,
                          follow: _follow,
                          hideWhenJoinedOn: widget.subject,
                          onJoin: _joinLive),
                    Expanded(
                        child: Stack(children: [
                        if (page != null && _inTree) page.build(),
                        if (!_skeletonGone)
                          Positioned.fill(
                            // The page's header is the page's own: once it is
                            // painted, only what is under it stays covered.
                            top: _headerShown ? kEmbedNavBarHeight : 0,
                            child: AnimatedOpacity(
                              opacity: _revealed ? 0 : 1,
                              duration: ResourceView.revealFade,
                              onEnd: () {
                                if (_revealed && mounted) {
                                  setState(() => _skeletonGone = true);
                                }
                              },
                              child: const ResourceSkeleton(),
                            ),
                          ),
                        // Next to the list the bar has no room for the resource's
                        // menu: it sits in the pane's top right corner.
                        if (widget.path == null &&
                            ShellScope.maybeOf(context) != null &&
                            ShellScope.layoutOf(context) == ShellLayout.split)
                          Positioned(
                            top: 0,
                            right: kEmbedNavBarTrailingInset,
                            child: const ResourceMoreButton(),
                          ),
                        // Who else has this resource open, in the page's top right
                        // corner (before the more button where the pane has it).
                        if (_watch != null && _announces)
                          Positioned(
                            top: 0,
                            right: kEmbedNavBarTrailingInset +
                                (ShellScope.maybeOf(context) != null &&
                                        ShellScope.layoutOf(context) ==
                                            ShellLayout.split
                                    ? kEmbedNavBarHeight
                                    : 8),
                            height: kEmbedNavBarHeight,
                            child: Center(
                              child: PresenceFacepile(
                                  watch: _watch!,
                                  follow: _follow,
                                  subject: widget.subject,
                                  onTap: _avatarTapped),
                            ),
                          ),
                        // The swipe back over the web view, which takes the touches.
                        Positioned.fill(
                          child: PageSwipe(blocked: () => _horizontal),
                        ),
                        ])),
                  ]),
          ),
        ));
  }
}

/// Height of the web page's header row (the embed's `HEADER_HEIGHT`), which
/// the native "more" button on a tablet sits in and is centred on.
const kEmbedNavBarHeight = 36.0;

/// Gap between the native "more" button and the pane's right edge: with the
/// button's 8 dp of inner space the icon sits 12 dp in, like the web header's
/// own padding.
const kEmbedNavBarTrailingInset = 4.0;

/// Names of the person's drives by [driveKey], as the home last read them:
/// the page's breadcrumb starts with the drive before it has read the drive.
final Map<String, String> knownDriveNames = {};

/// What covers a resource page until its web view shows the resource: the
/// page's own background (white, or black in dark mode), nothing else. The
/// header is never drawn here: the page draws it from its first frame, with
/// the titles the app passed ([_ResourceViewState._crumbHint]), and from then
/// on this covers only the part under it.
class ResourceSkeleton extends StatelessWidget {
  const ResourceSkeleton({super.key});

  static const headerHeight = kEmbedNavBarHeight;

  @override
  Widget build(BuildContext context) => ColoredBox(
        key: const Key('resource-skeleton'),
        color: Theme.of(context).brightness == Brightness.dark
            ? Colors.black
            : Colors.white,
      );
}

/// The drive [subject] is in, from its `drive` property (a drive is its own),
/// or null when the store does not know.
Future<String?> driveOfResource(AssistantApi api, String subject) async {
  var res =
      jsonDecode(await api.embedCall('getResource', jsonEncode([subject])));
  if (res is String) res = jsonDecode(res);
  if (res is! Map) return null;
  final drive = res['https://atomicdata.dev/properties/drive'];
  if (drive is String && drive.isNotEmpty) return drive;
  final isA = res['https://atomicdata.dev/properties/isA'];
  if (isA is List && isA.contains('https://atomicdata.dev/classes/Drive')) {
    return subject;
  }
  return null;
}

/// Shows [subject]'s "more" menu over the native screen below: the web app's
/// own menu (same items, order and behaviour as on a web page; one source of
/// truth), on a transparent page that closes with the menu and the dialogs of
/// its actions. An action that opens a page of its own turns the overlay into
/// that page.
Future<void> showResourceMenu(
  BuildContext context, {
  required AssistantApi api,
  required String drive,
  required String subject,
  required Rect anchor,
}) =>
    Navigator.of(context).push(PageRouteBuilder<void>(
      opaque: false,
      transitionDuration: Duration.zero,
      reverseTransitionDuration: Duration.zero,
      pageBuilder: (_, __, ___) => ResourceView(
          api: api, drive: drive, subject: subject, menuAnchor: anchor),
    ));
