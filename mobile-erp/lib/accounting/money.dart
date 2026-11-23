/// Amounts are stored as whole cents (`int`) so sums never drift; the
/// screens parse and show them with two decimals.
library;

/// Cents per unit of the base currency.
const int centsPerUnit = 100;

/// «1,500.25» / «١٥٠٠٫٢٥» / «1500» → 150025; null when not a number.
int? parseCents(String text) {
  var t = text.trim();
  if (t.isEmpty) return null;
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  final b = StringBuffer();
  for (final r in t.runes) {
    final ch = String.fromCharCode(r);
    var i = arabic.indexOf(ch);
    if (i < 0) i = persian.indexOf(ch);
    if (i >= 0) {
      b.write(i);
    } else if (ch == '٫') {
      b.write('.');
    } else if (ch == ',' || ch == '٬' || ch == ' ') {
      continue;
    } else {
      b.write(ch);
    }
  }
  t = b.toString();
  final m = RegExp(r'^(-)?(\d+)(?:\.(\d{1,2})\d*)?$').firstMatch(t);
  if (m == null) return null;
  final whole = int.parse(m.group(2)!);
  final frac = (m.group(3) ?? '').padRight(2, '0');
  final cents = whole * centsPerUnit + int.parse(frac.isEmpty ? '0' : frac);
  return m.group(1) == null ? cents : -cents;
}

/// 150025 → «1,500.25»; [signed] keeps a «−» for negatives.
String formatCents(int cents, {bool signed = true}) {
  final neg = cents < 0;
  final abs = cents.abs();
  final whole = (abs ~/ centsPerUnit).toString();
  final frac = (abs % centsPerUnit).toString().padLeft(2, '0');
  final grouped = whole.replaceAllMapped(
    RegExp(r'\B(?=(\d{3})+(?!\d))'),
    (_) => ',',
  );
  return '${neg && signed ? '−' : ''}$grouped.$frac';
}

/// «1,500» without decimals when whole (small figures), «1,500.25» else.
String formatCentsShort(int cents) {
  final s = formatCents(cents);
  return s.endsWith('.00') ? s.substring(0, s.length - 3) : s;
}

/// A percentage in basis points: 1250 → «12.5», 300 → «3».
String formatPercent(int bp) {
  final s = (bp / 100).toStringAsFixed(2);
  return s.contains('.') ? s.replaceAll(RegExp(r'\.?0+$'), '') : s;
}

/// 1500.25 → 150025 (rounded half away from zero).
int centsOf(num value) => (value * centsPerUnit).round();
