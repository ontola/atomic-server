import 'dart:ui' show Locale, PlatformDispatcher;

import 'package:flutter/widgets.dart';

/// The words of the shared Atomic widgets (the user panel, the account button,
/// the link dialog, the drive list, the device cards), in English and Dutch.
///
/// There is no codegen: [AtomicStrings.of] picks [nl] when the app's locale
/// (`Localizations`) is Dutch and [en] for everything else. An app that wants
/// another choice sets [override] once (for example from its own language
/// setting); it wins over the locale until it is set back to null.
///
/// ```dart
/// AtomicStrings.override = AtomicStrings.nl; // always Dutch
/// ```
///
/// Copy rules: it is always a "drive" (no other word for it), Dutch
/// never uses an em dash or an en dash as a dash, and plain words are used
/// ("je account", "dit apparaat", "geheime sleutel").
class AtomicStrings {
  const AtomicStrings._(this.languageCode);

  /// English.
  static const en = AtomicStrings._('en');

  /// Dutch.
  static const nl = AtomicStrings._('nl');

  /// Forces a language for every widget and note, whatever the locale says.
  static AtomicStrings? override;

  /// The strings for a language code ('nl' is Dutch, anything else English).
  static AtomicStrings forLanguage(String? languageCode) =>
      languageCode == 'nl' ? nl : en;

  /// The strings for [context]'s locale (and for the device's when the tree
  /// has no `Localizations`). Depends on the locale, so a language change
  /// rebuilds the caller.
  static AtomicStrings of(BuildContext context) =>
      override ??
      forLanguage((Localizations.maybeLocaleOf(context) ??
              PlatformDispatcher.instance.locale)
          .languageCode);

  /// The strings for a [locale].
  static AtomicStrings forLocale(Locale? locale) =>
      override ?? forLanguage(locale?.languageCode);

  final String languageCode;

  bool get _nl => languageCode == 'nl';
  String _t(String en, String nl) => _nl ? nl : en;

  // Generic
  String get cancel => _t('Cancel', 'Annuleren');
  String get save => _t('Save', 'Opslaan');
  String get close => _t('Close', 'Sluiten');
  String get copy => _t('Copy', 'Kopiëren');
  String get copiedShort => _t('Copied', 'Gekopieerd');
  String copied(String what) => _t('$what copied', '$what gekopieerd');
  String get showMore => _t('Show more', 'Meer tonen');
  String get showLess => _t('Show less', 'Minder tonen');
  String get loading => _t('Loading', 'Laden');
  String get moreOptions => _t('More options', 'Meer opties');
  String get tryAgain => _t('Try again', 'Opnieuw proberen');
  String get remove => _t('Remove', 'Verwijderen');
  String get add => _t('Add', 'Toevoegen');
  String get name => _t('Name', 'Naam');

  // The panel
  String get userTitle => _t('User', 'Gebruiker');
  String get accountTooltip => _t('Account', 'Account');

  /// What a drive is called until its name is known, and in a list of drives.
  String get drive => _t('Drive', 'Drive');
  String get noDrive => _t('No drive', 'Geen drive');
  String get newDrive => _t('New drive', 'Nieuwe drive');
  String get you => _t('You', 'Jij');

  /// The default guest name ("Me") as a label; the stored name is not changed.
  String get guestName => _t('Me', 'Ik');

  /// How a stored agent name is shown: the default guest name "Me" reads "Ik"
  /// in Dutch. Everything else is the person's own text. Display only.
  String agentLabel(String name) => _nl && name == 'Me' ? guestName : name;

  /// How a stored drive name is shown: the guest's default drive ("Me's
  /// Drive") reads "Mijn drive" in Dutch. Display only.
  String driveLabel(String name) =>
      _nl && name == "Me's Drive" ? 'Mijn drive' : name;
  String get deviceNameTitle => _t('Device name', 'Apparaatnaam');
  String get onlyThisDevice =>
      _t('Only on this device', 'Alleen op dit apparaat');
  String get couldNotRename =>
      _t('Could not rename the device', 'Kon het apparaat niet hernoemen');
  String get yourName => _t('Your name', 'Je naam');
  String get nameHint => _t(
      'Name, seen on all your devices', 'Naam, zichtbaar op al je apparaten');
  String get couldNotSaveName =>
      _t('Could not save the name', 'Kon de naam niet opslaan');
  String get couldNotCreateDrive =>
      _t('Could not create the drive', 'Kon de drive niet maken');
  String get couldNotSwitchDrive =>
      _t('Could not switch drive', 'Kon niet wisselen van drive');
  String get couldNotCopySecret => _t(
      'Could not copy the secret key', 'Kon de geheime sleutel niet kopiëren');
  String get couldNotShowSecret =>
      _t('Could not show the secret key', 'Kon de geheime sleutel niet tonen');
  String get secretKey => _t('Secret key', 'Geheime sleutel');
  String get agentId => _t('Agent ID', 'Account-ID');
  String get copyId => _t('Copy ID', 'ID kopiëren');
  String get signOutTitle => _t('Sign out?', 'Uitloggen?');
  String get signOutBody => _t(
      "Your data stays on this device, but you'll need your secret key to sign back in.",
      'Je gegevens blijven op dit apparaat, maar om weer in te loggen heb je je geheime sleutel nodig.');
  String get signOut => _t('Sign out', 'Uitloggen');
  String get couldNotSignOut => _t('Could not sign out', 'Kon niet uitloggen');
  String get openInvite => _t('Open an invite', 'Open een uitnodiging');
  String get pasteInvite =>
      _t('Paste the invite link', 'Plak de uitnodigingslink');
  String get couldNotOpenInvite =>
      _t('Could not open the invite', 'Kon de uitnodiging niet openen');
  String get inviteTitle =>
      _t('Invite to this drive', 'Uitnodigen voor deze drive');
  String get canRead => _t('Can read', 'Kan lezen');
  String get canEdit => _t('Can edit', 'Kan bewerken');
  String get inviteCopiedPeer => _t(
      'Link copied. Whoever has it can open this drive in their Atomic app, while this device is online.',
      'Link gekopieerd. Wie hem heeft, kan deze drive openen in de Atomic-app, zolang dit apparaat online is.');
  String get inviteCopiedAnyone => _t(
      'Link copied. Anyone with it can open this drive.',
      'Link gekopieerd. Iedereen met deze link kan deze drive openen.');
  String couldNotMakeLink(String why) =>
      _t('Could not make the link: $why', 'Kon de link niet maken: $why');
  String get copyInviteLink =>
      _t('Copy invite link', 'Uitnodigingslink kopiëren');
  String get editProfile => _t('Edit profile', 'Profiel bewerken');
  String get editYourName => _t('Edit your name', 'Je naam bewerken');
  String get copySecretKey => _t('Copy secret key', 'Geheime sleutel kopiëren');
  String get signInToAnother =>
      _t('Sign in to another account', 'Inloggen met een ander account');
  String get showSecretKey => _t('Show secret key', 'Geheime sleutel tonen');
  String get hideSecretKey =>
      _t('Hide secret key', 'Geheime sleutel verbergen');
  String signInWith(String provider) =>
      _t('Sign in with $provider', 'Inloggen met $provider');
  String linkedTo(String provider) =>
      _t('Linked to $provider', 'Gekoppeld aan $provider');
  String get signInWithSecret =>
      _t('Sign in with a secret key', 'Inloggen met een geheime sleutel');
  String get signInHelper => _t('What you made on this device is added to it.',
      'Je werk op dit apparaat wordt toegevoegd.');
  String get signIn => _t('Sign in', 'Inloggen');
  String driveNotHereYet(int n) => _t(
      '$n more ${n == 1 ? 'drive' : 'drives'} not on this device yet',
      n == 1
          ? '1 andere drive staat nog niet op dit apparaat'
          : '$n andere drives staan nog niet op dit apparaat');
  String get inviteSomeone => _t('Invite someone', 'Iemand uitnodigen');

  // Notes after a sign-in or an invite (built by the backend)
  String get signedIn => _t('You are signed in.', 'Je bent ingelogd.');
  String get untitledDrive => _t('Untitled drive', 'Drive zonder naam');

  /// "Notes", "Notes and Recipes", "Notes, Recipes and Cooking"; [names] are
  /// already quoted.
  String joinNames(List<String> names) {
    if (names.length < 2) return names.join();
    return '${names.sublist(0, names.length - 1).join(', ')} '
        '${_t('and', 'en')} ${names.last}';
  }

  String addedToAccount(List<String> quotedNames) => _t(
      'Added to your account: ${joinNames(quotedNames)}.',
      'Toegevoegd aan je account: ${joinNames(quotedNames)}.');
  String get driveNotOnDevice => _t(
      'Your drive is not on this device yet. Connect to a server or add a device to get it.',
      'Je drive staat nog niet op dit apparaat. Maak verbinding met een server of voeg een apparaat toe om hem op te halen.');
  String get couldNotOpenBrowser =>
      _t('Could not open the browser.', 'Kon de browser niet openen.');
  String get signedOut => _t('You are signed out.', 'Je bent uitgelogd.');
  String get noDriveToInvite => _t('There is no drive to invite to.',
      'Er is geen drive om voor uit te nodigen.');
  String notReachable(String why) => _t(
      'This device cannot be reached by others right now. $why',
      'Andere apparaten kunnen dit apparaat nu niet bereiken. $why');
  String get theDrive => _t('the drive', 'de drive');
  String inviteOpened(String what, {required bool write}) => _t(
      'You can now ${write ? 'edit' : 'read'} $what, and it is open.',
      'Je kunt $what nu ${write ? 'bewerken' : 'lezen'} en de drive is geopend.');
  String get stillLoading => _t('It is still loading from the other device.',
      'Hij wordt nog geladen vanaf het andere apparaat.');
  String get alreadyInSync =>
      _t('Everything was already in sync.', 'Alles was al gesynchroniseerd.');
  String synced(int received, int sent) => _t(
      'Received $received and sent $sent items.',
      '$received ontvangen en $sent verstuurd.');
  String deviceAdded(String detail) =>
      _t('Device added. $detail', 'Apparaat toegevoegd. $detail');

  // Adding a device
  String get addDeviceTitle => _t('Add a device', 'Voeg een apparaat toe');
  String get addDeviceBody => _t(
      'Type this code on your other device, or scan it, to sync without a server.',
      'Typ deze code op je andere apparaat, of scan hem, om zonder server te synchroniseren.');
  String get copyCode => _t('Copy code', 'Code kopiëren');
  String get codeFromOther =>
      _t('Code from another device', 'Code van een ander apparaat');
  String get addDevice => _t('Add device', 'Apparaat toevoegen');
  String get notACode => _t('That is not a code from another device.',
      'Dit is geen code van een ander apparaat.');

  // The account link dialog
  String connectTo(String host) =>
      _t('Connect to $host', 'Verbinden met $host');
  String get goToOnAnyDevice =>
      _t('On any device, go to', 'Ga op een willekeurig apparaat naar');
  String get andEnterCode => _t('and enter this code:', 'en vul deze code in:');
  String get orScan => _t('Or scan it with a phone that is signed in.',
      'Of scan hem met een telefoon waarop je bent ingelogd.');
  String get waitingForApproval =>
      _t('Waiting for approval…', 'Wachten op goedkeuring…');
  String get openInBrowser => _t('Open in your browser', 'Open in je browser');
  String get codeExpired => _t('That code expired. Start again.',
      'Deze code is verlopen. Begin opnieuw.');
  String get tooManyAttempts => _t(
      'Too many attempts. Wait a minute, then try again.',
      'Te veel pogingen. Wacht een minuut en probeer het opnieuw.');

  // This device
  String get thisDevice => _t('This device', 'Dit apparaat');
  String get deviceNameHint => _t(
      'Device name, only on this device. Tap to rename.',
      'Apparaatnaam, alleen op dit apparaat. Tik om te hernoemen.');
  String get status => _t('Status', 'Status');
  String get online => _t('Online', 'Online');
  String get offline => _t('Offline', 'Offline');
  String get version => _t('Version', 'Versie');
  String get deviceId => _t('Device ID', 'Apparaat-ID');
  String get identity => _t('Identity', 'Account-ID');
  String get syncedWith => _t('Synced with', 'Gesynchroniseerd met');
  String get noDeviceYet => _t('No device yet', 'Nog geen apparaat');
  String devices(int n) => _t('$n ${n == 1 ? 'device' : 'devices'}',
      '$n ${n == 1 ? 'apparaat' : 'apparaten'}');
  String get lastSync => _t('Last sync', 'Laatst gesynchroniseerd');
  String get connectedNow => _t('Connected now', 'Nu verbonden');
  String get none => _t('None', 'Geen');
  String get storage => _t('Storage', 'Opslag');
  String get onDisk => _t('On disk', 'Op schijf');
  String get countAgain => _t('Count again', 'Opnieuw tellen');
  String filesSize(String size) => _t('$size files', '$size aan bestanden');
  String storageValue(String size, int n) => _t(
      '$size · $n ${n == 1 ? 'drive' : 'drives'}',
      '$size · $n ${n == 1 ? 'drive' : 'drives'}');
  String storageOf(String name) => _t('Storage of $name', 'Opslag van $name');
  String resources(String count, int n) => _t(
      '$count ${n == 1 ? 'resource' : 'resources'}',
      '$count ${n == 1 ? 'item' : 'items'}');

  // Time
  String get justNow => _t('just now', 'zojuist');
  String minutesAgo(int n) => _t('${n}m ago', '$n min geleden');
  String hoursAgo(int n) => _t('${n}h ago', '$n uur geleden');
  String daysAgo(int n) => _t('${n}d ago', '$n d geleden');

  // Paired devices
  String get relationSameAgent => _t('Your device', 'Jouw apparaat');
  String get relationContact => _t('Shared with you', 'Met jou gedeeld');
  String get relationReplica => _t('Holds your data', 'Bewaart jouw gegevens');
  String received(int n) => _t('received $n', '$n ontvangen');
  String sent(int n) => _t('sent $n', '$n verstuurd');
  String get connected => _t('Connected', 'Verbonden');
  String get paired => _t('Paired', 'Gekoppeld');
  String get someoneElsesDevice => _t(
      "Someone else's device. It gets only what they may read: the drives shared with them.",
      'Het apparaat van iemand anders. Het krijgt alleen wat die persoon mag lezen: de drives die met hem of haar zijn gedeeld.');
  String get signedInAs => _t('Signed in as', 'Ingelogd als');
  String get agent => _t('Agent', 'Account');
  String get id => _t('ID', 'ID');
  String get lastSynced => _t('Last synced', 'Laatst gesynchroniseerd');
  String get notYet => _t('Not yet', 'Nog niet');
  String get justNowCap => _t('Just now', 'Zojuist');
  String get drives => _t('Drives', 'Drives');
  String get syncing => _t('Syncing…', 'Synchroniseren…');
  String get syncNow => _t('Sync now', 'Nu synchroniseren');
  String get forgetDevice => _t('Forget this device', 'Dit apparaat vergeten');

  // Devices and servers
  String get devicesHeader => _t('Devices', 'Apparaten');
  String get noOtherDevices => _t('No other devices yet. Pair one below.',
      'Nog geen andere apparaten. Koppel er hieronder een.');
  String get noOtherDevicesOrServer => _t(
      'No other devices yet. Pair one below, or add an always-on device by address.',
      'Nog geen andere apparaten. Koppel er hieronder een, of voeg een apparaat dat altijd aan staat toe met zijn adres.');
  String couldNotConnect(String why) =>
      _t('Could not connect: $why', 'Kon geen verbinding maken: $why');
  String get alreadyUpToDate => _t('Already up to date', 'Al bijgewerkt');
  String syncedToServer(int n, String server) => _t(
      'Synced $n ${n == 1 ? 'resource' : 'resources'} to $server',
      '$n ${n == 1 ? 'item' : 'items'} gesynchroniseerd naar $server');
  String get tryingAgainIn => _t('trying again in', 'opnieuw proberen over');
  String get searchAgain => _t('Search again', 'Opnieuw zoeken');
  String get inUse => _t('In use', 'In gebruik');
  String lastSyncedAgo(String ago) =>
      _t('last synced $ago', 'laatst gesynchroniseerd $ago');
  String get syncDriveHere =>
      _t('Sync drive here', 'Drive hierheen synchroniseren');
  String get switchToThis => _t('Switch to this', 'Hierop overschakelen');
  String get notReachableServer => _t('Not reachable', 'Niet bereikbaar');
  String resourceCount(int n) => _t('$n resources', '$n items');
  String filesAndEdits(String files, String edits) => _t(
      'files $files · edits $edits', 'bestanden $files · bewerkingen $edits');
  String get connectedNotSaved =>
      _t('Connected to you · not saved', 'Met jou verbonden · niet bewaard');
  String get serverAddressUnknown =>
      _t('Server, address unknown', 'Server, adres onbekend');
  String get upToDateLive =>
      _t('Up to date, syncing live', 'Bijgewerkt, synchroniseert live');
  String get notSyncedYet => _t('Not synced yet', 'Nog niet gesynchroniseerd');
  String via(String relay) => _t('via $relay', 'via $relay');
  String get dataSizeUnknown =>
      _t('Data size unknown', 'Hoeveel gegevens is onbekend');
  String get pairWithQr => _t('Pair with QR code', 'Koppelen met QR-code');
  String get connectByAddress =>
      _t('Connect by address', 'Verbinden met een adres');
}
