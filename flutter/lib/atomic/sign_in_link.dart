/// The sign-in link the portal mails (`https://atomic.place/signin?token=…`),
/// which Android App Links and iOS Universal Links hand to the app instead of
/// the browser. Without the app the same link opens the portal's page.
class SignInLink {
  const SignInLink({required this.token, this.invite});

  /// The single-use login token; spent by `AccountStore.redeemSignInLink`.
  final String token;

  /// The invitation the sign-up carried, if any. The app has no use for it
  /// yet; kept so it is not lost silently.
  final String? invite;

  /// The path the mail links to. Keep in sync with the portal (`MAGIC_LINK_PATH`
  /// in atomic-saas), the Android intent filter and the AASA `applinks`.
  static const path = '/signin';

  /// The link as a [SignInLink], or null when [link] is anything else. Only
  /// https links to [portal]'s own host (and port) count: a token must never
  /// be sent to a server the link merely names.
  static SignInLink? parse(String link, {required Uri portal}) {
    final uri = Uri.tryParse(link.trim());
    if (uri == null ||
        uri.scheme != 'https' ||
        uri.host.toLowerCase() != portal.host.toLowerCase() ||
        uri.port != portal.port ||
        uri.userInfo.isNotEmpty ||
        (uri.path != path && uri.path != '$path/')) {
      return null;
    }
    final token = uri.queryParameters['token'];
    if (token == null || token.isEmpty) return null;
    final invite = uri.queryParameters['invite'];
    return SignInLink(
        token: token, invite: invite == null || invite.isEmpty ? null : invite);
  }
}
