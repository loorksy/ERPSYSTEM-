/// Small helpers that reproduce JavaScript number semantics used by the ERP
/// audit code (`parseFloat`, `String(number)`, `Math.round`, property order),
/// so the phone produces exactly the same results as the ERP server.
library;

final RegExp _jsFloatPrefix = RegExp(
  r'^[+-]?(?:Infinity|(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?|\.(\d+)(?:[eE]([+-]?\d+))?)',
);

/// JavaScript `parseFloat`: parses the longest numeric prefix, ignoring
/// leading whitespace. Returns `double.nan` when there is no numeric prefix.
double jsParseFloat(Object? value) {
  if (value == null) return double.nan;
  final text = value.toString().replaceFirst(RegExp(r'^\s+'), '');
  final match = _jsFloatPrefix.firstMatch(text);
  if (match == null) return double.nan;
  final whole = match.group(0)!;
  final negative = whole.startsWith('-');
  if (whole.endsWith('Infinity')) {
    return negative ? double.negativeInfinity : double.infinity;
  }
  String intPart;
  String fracPart;
  String? exp;
  if (match.group(1) != null) {
    intPart = match.group(1)!;
    fracPart = match.group(2) ?? '';
    exp = match.group(3);
  } else {
    intPart = '0';
    fracPart = match.group(4) ?? '';
    exp = match.group(5);
  }
  final normalized =
      '${negative ? '-' : ''}$intPart.${fracPart.isEmpty ? '0' : fracPart}'
      '${exp == null ? '' : 'e$exp'}';
  return double.tryParse(normalized) ?? double.nan;
}

bool jsIsFiniteNumber(double n) => !n.isNaN && n.isFinite;

/// JavaScript `String(number)` for doubles.
String jsNumberToString(num value) {
  final d = value.toDouble();
  if (d.isNaN) return 'NaN';
  if (d == double.infinity) return 'Infinity';
  if (d == double.negativeInfinity) return '-Infinity';
  if (d == 0) return '0';
  var s = d.toString();
  if (s.endsWith('.0')) s = s.substring(0, s.length - 2);
  return s;
}

/// JavaScript `Math.round`: nearest integer, ties toward +infinity.
double jsRound(double x) {
  if (x.isNaN || x.isInfinite) return x;
  final f = x.floorToDouble();
  return (x - f) >= 0.5 ? f + 1 : f;
}

/// JavaScript `Math.floor`.
double jsFloor(double x) => x.floorToDouble();

bool _isArrayIndexKey(String key) {
  if (key.isEmpty || key.length > 10) return false;
  if (key != '0' && key.startsWith('0')) return false;
  for (final c in key.codeUnits) {
    if (c < 0x30 || c > 0x39) return false;
  }
  final n = int.parse(key);
  return n < 4294967295;
}

/// The order `Object.keys` would return for keys inserted in [insertionOrder]:
/// integer-like keys ascending, then the remaining keys in insertion order.
List<String> jsObjectKeyOrder(Iterable<String> insertionOrder) {
  final ints = <String>[];
  final others = <String>[];
  for (final k in insertionOrder) {
    (_isArrayIndexKey(k) ? ints : others).add(k);
  }
  ints.sort((a, b) => int.parse(a).compareTo(int.parse(b)));
  return [...ints, ...others];
}
