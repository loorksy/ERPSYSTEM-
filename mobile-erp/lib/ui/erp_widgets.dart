// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../erp/normalize.dart';
import 'erp_theme.dart';

// ------------------------------------------------------------------ toast

enum ToastType { success, error, warning, info }

/// The toast on screen. Removed explicitly: a toast replaced in the same
/// frame it was shown is not mounted yet, and must still go away.
class _Toast {
  _Toast(this.entry);
  final OverlayEntry entry;
  bool _gone = false;
  void remove() {
    if (_gone) return;
    _gone = true;
    try {
      entry.remove();
    } catch (_) {}
  }
}

_Toast? _toast;
Timer? _toastTimer;

/// ERP `showToast(message, type)`, drawn like the mockup's `.toast`: ink
/// background, paper text, one icon, above the bottom navigation and above
/// any open sheet (it lives in the root overlay).
void showToast(
  BuildContext context,
  String message, [
  ToastType type = ToastType.info,
]) {
  final overlay = Overlay.maybeOf(context, rootOverlay: true);
  if (overlay == null) return;
  final icon = switch (type) {
    ToastType.success => Icons.check,
    ToastType.error => Icons.error_outline,
    ToastType.warning => Icons.warning_amber_outlined,
    ToastType.info => Icons.info_outline,
  };
  _toastTimer?.cancel();
  _toast?.remove();
  final toast = _Toast(
    OverlayEntry(builder: (ctx) => _ToastView(message: message, icon: icon)),
  );
  overlay.insert(toast.entry);
  _toast = toast;
  _toastTimer = Timer(Duration(seconds: type == ToastType.error ? 6 : 4), () {
    toast.remove();
    if (identical(_toast, toast)) _toast = null;
  });
}

class _ToastView extends StatelessWidget {
  const _ToastView({required this.message, required this.icon});
  final String message;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewPadding.bottom;
    return Positioned(
      left: 16,
      right: 16,
      bottom: 88 + bottom,
      child: IgnorePointer(
        child: TweenAnimationBuilder<double>(
          tween: Tween(begin: 0, end: 1),
          duration: const Duration(milliseconds: 220),
          builder:
              (_, t, child) => Opacity(
                opacity: t,
                child: Transform.translate(
                  offset: Offset(0, 14 * (1 - t)),
                  child: child,
                ),
              ),
          child: Directionality(
            textDirection: TextDirection.rtl,
            child: Material(
              color: Tw.ink,
              borderRadius: BorderRadius.circular(16),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 13,
                ),
                child: Row(
                  children: [
                    Icon(
                      icon,
                      size: 18,
                      color: Tw.paper.withValues(alpha: 0.9),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        message,
                        style: TextStyle(
                          color: Tw.paper,
                          fontFamily: erpFont,
                          fontSize: 14.5,
                          fontWeight: FontWeight.w500,
                          height: 1.5,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------ cards

class ErpCard extends StatelessWidget {
  const ErpCard({
    super.key,
    required this.child,
    this.padding,
    this.clip = true,
  });
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final bool clip;

  @override
  Widget build(BuildContext context) => Container(
    clipBehavior: clip ? Clip.antiAlias : Clip.none,
    // Same surface as the panels of ui_kit.dart: white, hairline border.
    decoration: BoxDecoration(
      color: Tw.surface,
      borderRadius: BorderRadius.circular(20),
    ),
    padding: padding,
    child: child,
  );
}

/// A section inside a card, separated by a top border (`border-t`).
class CardSection extends StatelessWidget {
  const CardSection({
    super.key,
    required this.child,
    this.top = true,
    this.padding = const EdgeInsets.all(20),
  });
  final Widget child;
  final bool top;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    decoration: BoxDecoration(
      border: top ? Border(top: BorderSide(color: Tw.slate200)) : null,
    ),
    padding: padding,
    child: child,
  );
}

// ----------------------------------------------------------------- labels

class FieldLabel extends StatelessWidget {
  const FieldLabel(
    this.text, {
    super.key,
    this.small = false,
    this.bold = false,
  });
  final String text;
  final bool small;
  final bool bold;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Text(
      text,
      style: TextStyle(
        fontSize: small ? 13.5 : 15,
        fontWeight: bold || small ? FontWeight.w700 : FontWeight.w500,
        color: small ? Tw.ink2 : Tw.ink,
      ),
    ),
  );
}

class SectionCaption extends StatelessWidget {
  const SectionCaption(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Text(
      text,
      style: TextStyle(fontSize: 13, height: 1.65, color: Tw.ink2),
    ),
  );
}

// ----------------------------------------------------------------- select

class SelectOption<T> {
  const SelectOption(this.value, this.label);
  final T value;
  final String label;
}

/// A `<select>` styled like ERP (`min-h-[44px] rounded-lg border-slate-300`).
class ErpSelect<T> extends StatelessWidget {
  const ErpSelect({
    super.key,
    required this.options,
    required this.value,
    required this.onChanged,
    this.muted = false,
    this.enabled = true,
    this.thick = false,
  });

  final List<SelectOption<T>> options;
  final T value;
  final ValueChanged<T>? onChanged;
  final bool muted;
  final bool enabled;

  /// `.pad > .sel-wrap.wide`: a white select without a border, on the page
  /// background (the inquiry period).
  final bool thick;

  @override
  Widget build(BuildContext context) {
    final has = options.any((o) => o.value == value);
    final effective =
        has ? value : (options.isEmpty ? null : options.first.value);
    // `.pair select` / `.sel-wrap.wide` of the mockup: a filled field
    // without a border, 13 px corners, 48 px high.
    final radius = BorderRadius.circular(13);
    final side = BorderSide(
      color: muted && !thick ? Tw.rule : Colors.transparent,
      width: 1.5,
    );
    final callback =
        !enabled || onChanged == null
            ? null
            : (T? v) {
              if (v != null || null is T) onChanged!(v as T);
            };
    // A plain DropdownButton always shows [value]: when the parent ignores a
    // choice (e.g. a cancelled file or link picker) the old value stays.
    return InputDecorator(
      isEmpty: false,
      decoration: InputDecoration(
        filled: true,
        fillColor: muted || thick ? Tw.surface : Tw.surface2,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 13,
        ),
        border: OutlineInputBorder(borderRadius: radius, borderSide: side),
        enabledBorder: OutlineInputBorder(
          borderRadius: radius,
          borderSide: side,
        ),
        disabledBorder: OutlineInputBorder(
          borderRadius: radius,
          borderSide: side,
        ),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<T>(
          value: effective,
          isExpanded: true,
          isDense: true,
          menuMaxHeight: 420,
          icon: Icon(Icons.expand_more, size: 18, color: Tw.ink2),
          dropdownColor: Tw.surface,
          borderRadius: BorderRadius.circular(14),
          style: TextStyle(
            fontFamily: erpFont,
            fontSize: 15,
            fontWeight: FontWeight.w500,
            color: Tw.ink,
          ),
          items: [
            for (final o in options)
              DropdownMenuItem<T>(
                value: o.value,
                child: Text(o.label, overflow: TextOverflow.ellipsis),
              ),
          ],
          onChanged: callback,
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- buttons

enum ErpButtonKind {
  indigo,
  emerald,
  outline,
  amber,
  slate,
  danger,
  soft,
  indigoSoft,
}

class ErpButton extends StatelessWidget {
  const ErpButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.kind = ErpButtonKind.indigo,
    this.loading = false,
    this.loadingLabel,
    this.height = 52,
    this.expand = true,
    this.fontSize,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final ErpButtonKind kind;
  final bool loading;
  final String? loadingLabel;
  final double height;
  final bool expand;
  final double? fontSize;

  @override
  Widget build(BuildContext context) {
    // `.btn-primary`, `.btn-secondary`, `.btn-quiet`, `.btn-danger`.
    final (bg, fg) = switch (kind) {
      ErpButtonKind.indigo || ErpButtonKind.emerald => (Tw.accent, Tw.onAccent),
      ErpButtonKind.indigoSoft => (Tw.accentSoft, Tw.accentInk),
      ErpButtonKind.outline => (Colors.transparent, Tw.accentInk),
      ErpButtonKind.soft => (Tw.surface2, Tw.ink),
      ErpButtonKind.amber => (Tw.warnSoft, Tw.warn),
      ErpButtonKind.slate => (Tw.ink, Tw.paper),
      ErpButtonKind.danger => (
        Tw.danger,
        Tw.isDark ? const Color(0xff1a0d0a) : Colors.white,
      ),
    };
    final radius = BorderRadius.circular(height <= 42 ? 12 : 16);
    final disabled = onPressed == null || loading;
    final child = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (loading)
          SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(strokeWidth: 2, color: fg),
          )
        else if (icon != null)
          Icon(icon, size: height <= 42 ? 17 : 19, color: fg),
        if (loading || icon != null) const SizedBox(width: 8),
        Flexible(
          child: Text(
            loading ? (loadingLabel ?? label) : label,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontFamily: erpFont,
              fontWeight: FontWeight.w700,
              fontSize: fontSize ?? (height <= 42 ? 14.5 : 16),
              color: fg,
            ),
          ),
        ),
      ],
    );
    return Opacity(
      opacity: disabled && !loading ? 0.42 : 1,
      child: SizedBox(
        height: height,
        width: expand ? double.infinity : null,
        child: Material(
          color: bg,
          borderRadius: radius,
          child: InkWell(
            borderRadius: radius,
            onTap: disabled ? null : onPressed,
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: height <= 42 ? 14 : 20),
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}

// ----------------------------------------------------------------- inputs

class ErpTextField extends StatelessWidget {
  const ErpTextField({
    super.key,
    required this.controller,
    this.hint,
    this.keyboardType,
    this.ltr = false,
    this.onChanged,
    this.thick = false,
    this.maxLength,
    this.mono = false,
  });
  final TextEditingController controller;
  final String? hint;
  final TextInputType? keyboardType;
  final bool ltr;
  final ValueChanged<String>? onChanged;
  final bool thick;
  final int? maxLength;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(13);
    const side = BorderSide(color: Colors.transparent, width: 1.5);
    return TextField(
      controller: controller,
      keyboardType: keyboardType,
      textDirection: ltr ? TextDirection.ltr : null,
      onChanged: onChanged,
      maxLength: maxLength,
      style: TextStyle(
        fontSize: 16,
        fontWeight: FontWeight.w500,
        color: Tw.ink,
        fontFamily: mono ? 'monospace' : erpFont,
      ),
      decoration: InputDecoration(
        hintText: hint,
        counterText: '',
        filled: true,
        fillColor: thick ? Tw.surface : Tw.surface2,
        border: OutlineInputBorder(borderRadius: radius, borderSide: side),
        enabledBorder: OutlineInputBorder(
          borderRadius: radius,
          borderSide: side,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: radius,
          borderSide: BorderSide(color: Tw.accent, width: 1.5),
        ),
      ),
    );
  }
}

/// `<input type=color>` + hex text field, like the ERP color pickers.
class ColorField extends StatefulWidget {
  const ColorField({super.key, required this.value, required this.onChanged});
  final String value;
  final ValueChanged<String> onChanged;

  @override
  State<ColorField> createState() => _ColorFieldState();
}

class _ColorFieldState extends State<ColorField> {
  late final TextEditingController _text = TextEditingController(
    text: widget.value,
  );

  @override
  void didUpdateWidget(covariant ColorField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.value != _text.text) _text.text = widget.value;
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _pick() async {
    final picked = await showDialog<String>(
      context: context,
      builder: (_) => _ColorPickerDialog(initial: widget.value),
    );
    if (picked != null) widget.onChanged(picked);
  }

  @override
  Widget build(BuildContext context) => Row(
    children: [
      InkWell(
        onTap: _pick,
        borderRadius: BorderRadius.circular(11),
        child: Container(
          width: 44,
          height: 44,
          padding: const EdgeInsets.all(6),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(11),
            border: Border.all(color: Tw.rule, width: 1.5),
            color: Tw.surface,
          ),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: hexColor(widget.value),
              borderRadius: BorderRadius.circular(8),
            ),
          ),
        ),
      ),
      const SizedBox(width: 8),
      Expanded(
        child: ErpTextField(
          controller: _text,
          ltr: true,
          mono: true,
          maxLength: 7,
          onChanged: (v) {
            if (RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(v)) {
              widget.onChanged(v.toLowerCase());
            }
          },
        ),
      ),
    ],
  );
}

class _ColorPickerDialog extends StatefulWidget {
  const _ColorPickerDialog({required this.initial});
  final String initial;
  @override
  State<_ColorPickerDialog> createState() => _ColorPickerDialogState();
}

class _ColorPickerDialogState extends State<_ColorPickerDialog> {
  late String _value = widget.initial;
  static const _palette = <String>[
    '#8b5cf6',
    '#facc15',
    '#3b82f6',
    '#10b981',
    '#ef4444',
    '#f97316',
    '#f59e0b',
    '#84cc16',
    '#22c55e',
    '#14b8a6',
    '#06b6d4',
    '#0ea5e9',
    '#6366f1',
    '#a855f7',
    '#d946ef',
    '#ec4899',
    '#f43f5e',
    '#64748b',
    '#c4b5fd',
    '#fde68a',
    '#bfdbfe',
    '#a7f3d0',
    '#fecaca',
    '#fed7aa',
  ];

  late final _hex = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _hex.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('اختر اللون'),
    content: SizedBox(
      width: 300,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final c in _palette)
                InkWell(
                  onTap:
                      () => setState(() {
                        _value = c;
                        _hex.text = c;
                      }),
                  borderRadius: BorderRadius.circular(10),
                  child: Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: hexColor(c),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                        color: _value == c ? Tw.ink : Tw.rule,
                        width: _value == c ? 3 : 1,
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 14),
          ErpTextField(
            controller: _hex,
            ltr: true,
            mono: true,
            maxLength: 7,
            hint: '#8b5cf6',
            onChanged: (v) {
              if (RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(v)) {
                setState(() => _value = v.toLowerCase());
              }
            },
          ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('إلغاء'),
      ),
      FilledButton(
        style: FilledButton.styleFrom(
          backgroundColor: Tw.accent,
          foregroundColor: Tw.onAccent,
        ),
        onPressed: () => Navigator.pop(context, _value),
        child: const Text('اختيار'),
      ),
    ],
  );
}

// ----------------------------------------------------------------- badges

class ErpBadge extends StatelessWidget {
  const ErpBadge({
    super.key,
    required this.label,
    required this.icon,
    required this.bg,
    required this.fg,
    required this.border,
  });
  final String label;
  final IconData icon;
  final Color bg;
  final Color fg;
  final Color border;

  factory ErpBadge.google() => ErpBadge(
    label: 'مرتبطة بـ Google',
    icon: Icons.link,
    bg: Tw.accentSoft,
    fg: Tw.accentInk,
    border: Colors.transparent,
  );

  factory ErpBadge.local() => ErpBadge(
    label: 'ملفات محلية',
    icon: Icons.description_outlined,
    bg: Tw.neutralSoft,
    fg: Tw.ink2,
    border: Colors.transparent,
  );

  @override
  Widget build(BuildContext context) => Container(
    height: 24,
    padding: const EdgeInsets.symmetric(horizontal: 9),
    decoration: BoxDecoration(
      color: bg,
      borderRadius: BorderRadius.circular(999),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 13, color: fg),
        const SizedBox(width: 5),
        Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            color: fg,
          ),
        ),
      ],
    ),
  );
}

Future<String?> pasteText() async {
  final data = await Clipboard.getData(Clipboard.kTextPlain);
  return data?.text?.trim();
}

/// `rounded-xl border bg-… p-3` notice boxes.
class NoticeBox extends StatelessWidget {
  NoticeBox({
    super.key,
    required this.child,
    Color? bg,
    Color? border,
    this.padding = const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
  }) : bg = bg ?? Tw.surface2,
       border = border ?? Colors.transparent;
  final Widget child;
  final Color bg;
  final Color border;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: padding,
    decoration: BoxDecoration(
      color: bg,
      borderRadius: BorderRadius.circular(14),
    ),
    child: DefaultTextStyle.merge(
      style: const TextStyle(fontSize: 14, height: 1.6),
      child: child,
    ),
  );
}

/// A confirmation dialog in the style of ERP's delete modal.
Future<bool> confirmDialog(
  BuildContext context, {
  required IconData icon,
  required String title,
  required String body,
  required String confirmLabel,
  Color? iconColor,
  Color? iconBg,
  ErpButtonKind confirmKind = ErpButtonKind.indigo,
}) async {
  // `.dialog` of the mockup: title, text, then «إلغاء» and the action at
  // the end. ([icon], [iconColor] and [iconBg] are kept for the callers.)
  final ok = await showDialog<bool>(
    context: context,
    builder:
        (ctx) => Directionality(
          textDirection: TextDirection.rtl,
          child: Dialog(
            insetPadding: const EdgeInsets.symmetric(horizontal: 22),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(22, 22, 22, 14),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        fontSize: 19,
                        fontWeight: FontWeight.w800,
                        height: 1.4,
                        color: Tw.ink,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      body,
                      style: TextStyle(
                        fontSize: 15,
                        color: Tw.ink2,
                        height: 1.75,
                      ),
                    ),
                    const SizedBox(height: 18),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        ErpButton(
                          label: 'إلغاء',
                          kind: ErpButtonKind.outline,
                          height: 40,
                          expand: false,
                          onPressed: () => Navigator.pop(ctx, false),
                        ),
                        const SizedBox(width: 6),
                        ErpButton(
                          label: confirmLabel,
                          kind: confirmKind,
                          height: 40,
                          expand: false,
                          onPressed: () => Navigator.pop(ctx, true),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
  );
  return ok == true;
}

// ------------------------------------------------- mockup form controls

/// `.sel-wrap.col`: a compact select at the end of a form row; the field
/// shows [shown] of the value (e.g. the column letter) and the menu the
/// full labels.
class CompactSelect<T> extends StatelessWidget {
  const CompactSelect({
    super.key,
    required this.options,
    required this.value,
    required this.onChanged,
    this.shown,
    this.maxWidth = 150,
  });
  final List<SelectOption<T>> options;
  final T value;
  final ValueChanged<T>? onChanged;
  final String Function(T value)? shown;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    final has = options.any((o) => o.value == value);
    final effective =
        has ? value : (options.isEmpty ? null : options.first.value);
    String label(SelectOption<T> o) => shown?.call(o.value) ?? o.label;
    return ConstrainedBox(
      constraints: BoxConstraints(minWidth: 74, maxWidth: maxWidth),
      child: Container(
        height: 42,
        padding: const EdgeInsetsDirectional.only(start: 12, end: 6),
        decoration: BoxDecoration(
          color: Tw.surface,
          borderRadius: BorderRadius.circular(11),
          border: Border.all(color: Tw.rule, width: 1.5),
        ),
        child: DropdownButtonHideUnderline(
          child: DropdownButton<T>(
            value: effective,
            isExpanded: true,
            isDense: true,
            menuMaxHeight: 420,
            icon: Icon(Icons.expand_more, size: 16, color: Tw.ink2),
            dropdownColor: Tw.surface,
            borderRadius: BorderRadius.circular(14),
            style: TextStyle(
              fontFamily: erpFont,
              fontSize: 15,
              fontWeight: FontWeight.w700,
              color: Tw.ink,
            ),
            selectedItemBuilder:
                (_) => [
                  for (final o in options)
                    Align(
                      alignment: Alignment.center,
                      child: Text(
                        label(o),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
            items: [
              for (final o in options)
                DropdownMenuItem<T>(
                  value: o.value,
                  child: Text(
                    o.label,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w500),
                  ),
                ),
            ],
            onChanged:
                onChanged == null
                    ? null
                    : (T? v) {
                      if (v != null || null is T) onChanged!(v as T);
                    },
          ),
        ),
      ),
    );
  }
}

/// `.num-input`: a small centred number field.
class NumberBox extends StatelessWidget {
  const NumberBox({super.key, required this.controller, this.onChanged});
  final TextEditingController controller;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    final r = BorderRadius.circular(11);
    return SizedBox(
      height: 42,
      child: TextField(
        controller: controller,
        onChanged: onChanged,
        textAlign: TextAlign.center,
        textDirection: TextDirection.ltr,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        style: TextStyle(
          fontSize: 15,
          fontWeight: FontWeight.w700,
          color: Tw.ink,
        ),
        decoration: InputDecoration(
          filled: true,
          fillColor: Tw.surface,
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(vertical: 11),
          border: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide(color: Tw.rule, width: 1.5),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide(color: Tw.rule, width: 1.5),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide(color: Tw.accent, width: 1.5),
          ),
        ),
      ),
    );
  }
}

/// `.swatch`: the colour and its hex; opens the colour picker (palette or
/// a typed hex).
class ColorSwatchButton extends StatelessWidget {
  const ColorSwatchButton({
    super.key,
    required this.value,
    required this.onChanged,
  });
  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) => InkWell(
    borderRadius: BorderRadius.circular(11),
    onTap: () async {
      final picked = await showDialog<String>(
        context: context,
        builder: (_) => _ColorPickerDialog(initial: value),
      );
      if (picked != null) onChanged(picked);
    },
    child: Container(
      height: 42,
      padding: const EdgeInsetsDirectional.only(start: 6, end: 12),
      decoration: BoxDecoration(
        color: Tw.surface,
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: Tw.rule, width: 1.5),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(
              color: hexColor(value),
              borderRadius: BorderRadius.circular(8),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            value,
            textDirection: TextDirection.ltr,
            style: TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.w700,
              color: Tw.ink2,
            ),
          ),
        ],
      ),
    ),
  );
}

/// `.chip`: a filter with its count.
class FilterPill extends StatelessWidget {
  const FilterPill({
    super.key,
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
  });
  final String label;
  final String count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
    color: selected ? Tw.accentSoft : Colors.transparent,
    shape: StadiumBorder(
      side: BorderSide(color: selected ? Tw.accent : Tw.rule, width: 1.5),
    ),
    child: InkWell(
      customBorder: const StadiumBorder(),
      onTap: onTap,
      child: Container(
        height: 36,
        padding: const EdgeInsets.symmetric(horizontal: 13),
        alignment: Alignment.center,
        child: Text.rich(
          TextSpan(
            children: [
              TextSpan(text: '$label '),
              TextSpan(
                text: count,
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  color: selected ? Tw.accentInk : Tw.ink,
                ),
              ),
            ],
          ),
          style: TextStyle(
            fontSize: 14,
            color: selected ? Tw.accentInk : Tw.ink2,
          ),
        ),
      ),
    ),
  );
}

/// `.sheet-search`: the search field inside a sheet.
class SheetSearch extends StatelessWidget {
  const SheetSearch({
    super.key,
    required this.hint,
    required this.onChanged,
    this.controller,
  });
  final String hint;
  final ValueChanged<String> onChanged;
  final TextEditingController? controller;

  @override
  Widget build(BuildContext context) {
    final r = BorderRadius.circular(14);
    return SizedBox(
      height: 48,
      child: TextField(
        controller: controller,
        onChanged: onChanged,
        style: TextStyle(fontSize: 16, color: Tw.ink),
        decoration: InputDecoration(
          hintText: hint,
          filled: true,
          fillColor: Tw.surface2,
          prefixIcon: Icon(Icons.search, size: 18, color: Tw.ink3),
          contentPadding: const EdgeInsets.symmetric(vertical: 12),
          border: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide.none,
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide.none,
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: r,
            borderSide: BorderSide(color: Tw.accent, width: 1.5),
          ),
        ),
      ),
    );
  }
}

/// Column choices named like ERPSYSTEM («A - رقم المستخدم») from a header
/// row; a column without a title keeps its letter. At least [minColumns].
List<SelectOption<String>> columnOptions(
  List<String> header, {
  int minColumns = 52,
}) {
  final n = header.length > minColumns ? header.length : minColumns;
  return [
    for (var i = 0; i < n; i++)
      SelectOption(
        columnIndexToLetter(i),
        i < header.length && header[i].trim().isNotEmpty
            ? '${columnIndexToLetter(i)} - ${header[i].trim()}'
            : columnIndexToLetter(i),
      ),
  ];
}

/// «تحديث القوائم» (owner's request, 3.3.0): reloads the spreadsheets,
/// sheets and column names of a picker from Google, so a sheet added in
/// Google appears without restarting the app.
class RefreshAction extends StatefulWidget {
  const RefreshAction({super.key, required this.onRefresh});
  final Future<void> Function() onRefresh;

  @override
  State<RefreshAction> createState() => _RefreshActionState();
}

class _RefreshActionState extends State<RefreshAction> {
  bool _busy = false;

  Future<void> _run() async {
    setState(() => _busy = true);
    try {
      // The pickers show their own message when Google cannot be read.
      await widget.onRefresh();
    } catch (e) {
      if (mounted) showToast(context, '$e', ToastType.error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) =>
      _busy
          ? SizedBox(
            width: 48,
            height: 48,
            child: Center(
              child: SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Tw.accent,
                ),
              ),
            ),
          )
          : IconButton(
            tooltip: 'تحديث القوائم',
            onPressed: _run,
            icon: Icon(Icons.refresh, color: Tw.ink2),
          );
}

/// Owner's request (3.3.1): a list of columns chosen with «+ إضافة عمود»
/// from a dropdown of the sheet's columns («A - رقم المستخدم»), each shown
/// as a chip that × removes — instead of typing letters. [exclude]: columns
/// that may not be chosen here.
class ColumnChips extends StatelessWidget {
  const ColumnChips({
    super.key,
    required this.values,
    required this.onChanged,
    this.header = const [],
    this.exclude = const {},
    this.emptyText = 'لا يوجد',
  });
  final List<String> values;
  final ValueChanged<List<String>> onChanged;
  final List<String> header;
  final Set<String> exclude;
  final String emptyText;

  @override
  Widget build(BuildContext context) {
    final all = columnOptions(header);
    String name(String v) =>
        all.where((o) => o.value == v).firstOrNull?.label ?? v;
    final free = [
      for (final o in all)
        if (!values.contains(o.value) && !exclude.contains(o.value)) o,
    ];
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        for (final v in values)
          Container(
            padding: const EdgeInsetsDirectional.fromSTEB(14, 6, 6, 6),
            decoration: BoxDecoration(
              color: Tw.accentSoft,
              borderRadius: BorderRadius.circular(99),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  name(v),
                  style: TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w700,
                    color: Tw.accentInk,
                  ),
                ),
                const SizedBox(width: 4),
                Tooltip(
                  message: 'إزالة $v',
                  child: InkResponse(
                    radius: 18,
                    onTap: () => onChanged([...values]..remove(v)),
                    child: Padding(
                      padding: const EdgeInsets.all(4),
                      child: Icon(Icons.close, size: 17, color: Tw.accentInk),
                    ),
                  ),
                ),
              ],
            ),
          ),
        if (values.isEmpty)
          Text(emptyText, style: TextStyle(fontSize: 14.5, color: Tw.ink3)),
        PopupMenuButton<String>(
          tooltip: 'إضافة عمود',
          enabled: free.isNotEmpty,
          color: Tw.surface,
          constraints: const BoxConstraints(maxHeight: 420, minWidth: 200),
          onSelected: (v) => onChanged([...values, v]),
          itemBuilder:
              (_) => [
                for (final o in free)
                  PopupMenuItem<String>(
                    value: o.value,
                    child: Text(
                      o.label,
                      style: TextStyle(fontSize: 15, color: Tw.ink),
                    ),
                  ),
              ],
          child: Container(
            padding: const EdgeInsetsDirectional.fromSTEB(10, 7, 14, 7),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(99),
              border: Border.all(color: Tw.rule, width: 1.5),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.add, size: 18, color: Tw.accent),
                const SizedBox(width: 4),
                Text(
                  'إضافة عمود',
                  style: TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w700,
                    color: Tw.accent,
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
