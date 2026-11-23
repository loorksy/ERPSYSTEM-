import 'dart:async';

import 'package:google_sign_in/google_sign_in.dart';

/// Google scopes: Sheets to read and write the audit results, Drive
/// read-only to list the spreadsheets (as the ERP server), and Drive files
/// created by this app for the backups (folder «LorkERP»).
const googleAuditScopes = <String>[
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

/// The Google account is connected directly from the phone (no server).
class GoogleAuth {
  GoogleAuth({GoogleSignIn? signIn})
    : _signIn = signIn ?? GoogleSignIn(scopes: googleAuditScopes);

  final GoogleSignIn _signIn;
  GoogleSignInAccount? _account;

  GoogleSignInAccount? get account => _account;
  bool get isConnected => _account != null;
  String? get email => _account?.email;
  String? get displayName => _account?.displayName;

  final _changes = StreamController<GoogleSignInAccount?>.broadcast();
  Stream<GoogleSignInAccount?> get changes => _changes.stream;

  Future<bool> restore() async {
    try {
      _account = await _signIn.signInSilently();
    } catch (_) {
      _account = null;
    }
    _changes.add(_account);
    return _account != null;
  }

  Future<bool> connect() async {
    _account = await _signIn.signIn();
    if (_account != null) {
      final granted = await _signIn.requestScopes(googleAuditScopes);
      if (!granted) {
        await _signIn.signOut();
        _account = null;
      }
    }
    _changes.add(_account);
    return _account != null;
  }

  Future<void> disconnect() async {
    try {
      await _signIn.disconnect();
    } catch (_) {
      await _signIn.signOut();
    }
    _account = null;
    _changes.add(null);
  }

  Future<String> accessToken({bool forceRefresh = false}) async {
    var account = _account;
    if (account == null) {
      await restore();
      account = _account;
    }
    if (account == null) {
      throw const GoogleNotConnected();
    }
    if (forceRefresh) {
      try {
        await account.clearAuthCache();
      } catch (_) {}
    }
    final auth = await account.authentication;
    final token = auth.accessToken;
    if (token == null || token.isEmpty) throw const GoogleNotConnected();
    return token;
  }
}

class GoogleNotConnected implements Exception {
  const GoogleNotConnected();
  @override
  String toString() =>
      'لم يتم تسجيل الدخول بـ Google. اربط من الإعدادات → Google Sheets.';
}
