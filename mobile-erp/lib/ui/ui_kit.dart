// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'erp_theme.dart';

/// The design system of «المدقق» (3.1), from the owner's mockup
/// `docs/design/almudaqqiq-redesign.html`: ledger paper, white groups
/// without borders, one green accent, 26 px titles, 16 px row titles,
/// 66 px rows, 20–28 px corners. Explanations live behind the screen's
/// single «؟» (`help.dart`).
abstract final class Ds {
  /// `.pad` / `.section`: 16 px sides.
  static const pagePadding = EdgeInsets.fromLTRB(16, 4, 16, 32);
  static const gapS = 8.0;
  static const gapM = 12.0;

  /// `.group`.
  static const radius = 20.0;

  /// `.hero`, `.results`, `.run-card`, `.rcard`.
  static const radiusL = 26.0;
  static const radiusS = 13.0;
  static const touch = 44.0;

  /// `.section-hd h2`.
  static TextStyle get title =>
      TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700, color: Tw.ink);

  /// `.title` (screen title).
  static TextStyle get screenTitle => TextStyle(
    fontSize: 26,
    fontWeight: FontWeight.w800,
    height: 1.3,
    color: Tw.ink,
  );
  static TextStyle get body =>
      TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: Tw.ink);

  /// `.row-sub`, `.pmeta`.
  static TextStyle get secondary =>
      TextStyle(fontSize: 13.5, height: 1.5, color: Tw.ink2);

  /// `.caption`.
  static TextStyle get caption =>
      TextStyle(fontSize: 13, height: 1.65, color: Tw.ink2);

  /// `.sheet-label`, `.field-label`.
  static TextStyle get label =>
      TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: Tw.ink2);
}

/// Vertical space between blocks.
const gap = SizedBox(height: Ds.gapM);

// ---------------------------------------------------------------- sheets

/// `.sheet-grab`.
class SheetHandle extends StatelessWidget {
  const SheetHandle({super.key});
  @override
  Widget build(BuildContext context) => Center(
    child: Container(
      width: 40,
      height: 5,
      margin: const EdgeInsets.only(top: 10, bottom: 2),
      decoration: BoxDecoration(
        color: Tw.surface3,
        borderRadius: BorderRadius.circular(3),
      ),
    ),
  );
}

/// The bottom sheet of the mockup (`.sheet`): grab, a title with a close
/// button (and optional [actions]), a scrolling body and an optional
/// [footer] above a hairline.
class AppSheet extends StatelessWidget {
  const AppSheet({
    super.key,
    required this.title,
    required this.child,
    this.actions = const [],
    this.footer,
    this.scroll = true,
    this.padding = const EdgeInsets.fromLTRB(20, 4, 20, 22),
  });
  final String title;
  final Widget child;
  final List<Widget> actions;
  final Widget? footer;
  final bool scroll;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final body = Padding(padding: padding, child: child);
    return Directionality(
      textDirection: TextDirection.rtl,
      child: Padding(
        padding: EdgeInsets.only(bottom: mq.viewInsets.bottom),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: mq.size.height * 0.9),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SheetHandle(),
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 4, 10, 6),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        style: TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.w800,
                          height: 1.4,
                          color: Tw.ink,
                        ),
                      ),
                    ),
                    ...actions,
                    IconButton(
                      tooltip: 'إغلاق',
                      onPressed: () => Navigator.maybePop(context),
                      icon: Icon(Icons.close, color: Tw.ink2),
                    ),
                  ],
                ),
              ),
              Flexible(
                child: scroll ? SingleChildScrollView(child: body) : body,
              ),
              if (footer != null)
                Container(
                  padding: EdgeInsets.fromLTRB(
                    20,
                    12,
                    20,
                    18 + mq.padding.bottom,
                  ),
                  decoration: BoxDecoration(
                    border: Border(top: BorderSide(color: Tw.rule)),
                  ),
                  child: footer,
                )
              else
                SizedBox(height: mq.padding.bottom),
            ],
          ),
        ),
      ),
    );
  }
}

/// Opens an [AppSheet]-style bottom sheet.
Future<T?> showAppSheet<T>(BuildContext context, WidgetBuilder builder) =>
    showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      // Above the bottom navigation, like the mockup's sheets.
      useRootNavigator: true,
      builder: builder,
    );

Future<void> showInfo(BuildContext context, String text, {String? title}) =>
    showAppSheet<void>(
      context,
      (ctx) => AppSheet(
        title: title ?? 'تفاصيل',
        child: Text(
          text,
          style: TextStyle(fontSize: 15, color: Tw.ink2, height: 1.75),
        ),
      ),
    );

/// `.sheet-label`: the small title above a block inside a sheet.
class SheetLabel extends StatelessWidget {
  const SheetLabel(this.text, {super.key, this.first = false});
  final String text;
  final bool first;
  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(4, first ? 8 : 20, 4, 8),
    child: Text(text, style: Ds.label),
  );
}

/// `.choice`: one option in a sheet (a menu item or a pickable value).
class ChoiceTile extends StatelessWidget {
  const ChoiceTile({
    super.key,
    required this.icon,
    required this.label,
    this.onTap,
    this.selected = false,
    this.danger = false,
    this.tail,
  });
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool selected;
  final bool danger;
  final Widget? tail;

  @override
  Widget build(BuildContext context) {
    final fg =
        danger
            ? Tw.danger
            : selected
            ? Tw.accentInk
            : Tw.ink;
    final iconColor =
        danger
            ? Tw.danger
            : selected
            ? Tw.accentInk
            : Tw.ink2;
    return Opacity(
      opacity: onTap == null ? 0.45 : 1,
      child: Material(
        color: selected ? Tw.accentSoft : Colors.transparent,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 54),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              child: Row(
                children: [
                  Icon(icon, size: 20, color: iconColor),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      label,
                      style: TextStyle(
                        fontSize: 15.5,
                        fontWeight:
                            selected ? FontWeight.w700 : FontWeight.w500,
                        color: fg,
                      ),
                    ),
                  ),
                  if (tail != null)
                    DefaultTextStyle.merge(
                      style: TextStyle(
                        fontSize: 13,
                        color: selected ? Tw.accentInk : Tw.ink2,
                      ),
                      child: IconTheme.merge(
                        data: IconThemeData(
                          color: selected ? Tw.accentInk : Tw.ink2,
                          size: 18,
                        ),
                        child: tail!,
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ------------------------------------------------------------ surfaces

/// `.group`: a white surface without a border.
BoxDecoration panelDecoration({
  Color? border,
  Color? color,
  double radius = Ds.radius,
}) => BoxDecoration(
  color: color ?? Tw.surface,
  borderRadius: BorderRadius.circular(radius),
  border: border == null ? null : Border.all(color: border),
);

/// `.row-ico`: the rounded square with an icon at the start of a row.
class IconChip extends StatelessWidget {
  IconChip(this.icon, {super.key, Color? color, Color? bg, this.size = 38})
    : color = color ?? Tw.ink2,
      bg = bg ?? Tw.surface2;
  final IconData icon;
  final Color color;
  final Color bg;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: bg,
      borderRadius: BorderRadius.circular(size * 0.32),
    ),
    alignment: Alignment.center,
    child: Icon(icon, size: size * 0.53, color: color),
  );
}

/// A white surface with an optional header (title, icon, action).
class Panel extends StatelessWidget {
  Panel({
    super.key,
    this.title,
    this.icon,
    Color? iconColor,
    Color? iconBg,
    this.trailing,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.radius = Ds.radius,
  }) : iconColor = iconColor ?? Tw.ink2,
       iconBg = iconBg ?? Tw.surface2;
  final String? title;
  final IconData? icon;
  final Color iconColor;
  final Color iconBg;
  final Widget? trailing;
  final Widget child;
  final EdgeInsets padding;
  final double radius;

  @override
  Widget build(BuildContext context) => Container(
    decoration: panelDecoration(radius: radius),
    padding: padding,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null) ...[
          PanelHeader(
            title: title!,
            icon: icon,
            iconColor: iconColor,
            iconBg: iconBg,
            trailing: trailing,
          ),
          const SizedBox(height: 12),
        ],
        child,
      ],
    ),
  );
}

class PanelHeader extends StatelessWidget {
  PanelHeader({
    super.key,
    required this.title,
    this.icon,
    Color? iconColor,
    Color? iconBg,
    this.trailing,
    this.subtitle,
  }) : iconColor = iconColor ?? Tw.ink2,
       iconBg = iconBg ?? Tw.surface2;
  final String title;
  final IconData? icon;
  final Color iconColor;
  final Color iconBg;
  final Widget? trailing;
  final Widget? subtitle;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      if (icon != null) ...[
        IconChip(icon!, color: iconColor, bg: iconBg),
        const SizedBox(width: 14),
      ],
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                height: 1.45,
                color: Tw.ink,
              ),
            ),
            if (subtitle != null) ...[
              const SizedBox(height: 1),
              DefaultTextStyle.merge(style: Ds.secondary, child: subtitle!),
            ],
          ],
        ),
      ),
      if (trailing != null) trailing!,
    ],
  );
}

/// A surface whose content folds away; the header summarises the choices
/// while folded (progressive disclosure).
class CollapsiblePanel extends StatefulWidget {
  CollapsiblePanel({
    super.key,
    required this.title,
    required this.child,
    this.icon,
    Color? iconColor,
    Color? iconBg,
    this.summary,
    this.initiallyExpanded = false,
  }) : iconColor = iconColor ?? Tw.ink2,
       iconBg = iconBg ?? Tw.surface2;
  final String title;
  final Widget child;
  final IconData? icon;
  final Color iconColor;
  final Color iconBg;
  final Widget? summary;
  final bool initiallyExpanded;

  @override
  State<CollapsiblePanel> createState() => _CollapsiblePanelState();
}

class _CollapsiblePanelState extends State<CollapsiblePanel> {
  late bool _open = widget.initiallyExpanded;

  @override
  Widget build(BuildContext context) => Container(
    decoration: panelDecoration(),
    clipBehavior: Clip.antiAlias,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          onTap: () => setState(() => _open = !_open),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 8, 12),
            child: PanelHeader(
              title: widget.title,
              icon: widget.icon,
              iconColor: widget.iconColor,
              iconBg: widget.iconBg,
              subtitle: _open ? null : widget.summary,
              trailing: AnimatedRotation(
                turns: _open ? 0.5 : 0,
                duration: const Duration(milliseconds: 200),
                child: SizedBox(
                  width: 36,
                  height: 36,
                  child: Icon(Icons.expand_more, size: 20, color: Tw.ink2),
                ),
              ),
            ),
          ),
        ),
        AnimatedSize(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
          alignment: Alignment.topCenter,
          child:
              _open
                  ? Padding(
                    padding: const EdgeInsets.fromLTRB(16, 2, 16, 16),
                    child: widget.child,
                  )
                  : const SizedBox(width: double.infinity),
        ),
      ],
    ),
  );
}

/// `.disclosure`: a bold line with a chevron that shows / hides [child].
class Disclosure extends StatefulWidget {
  const Disclosure({super.key, required this.title, required this.child});
  final String title;
  final Widget child;
  @override
  State<Disclosure> createState() => _DisclosureState();
}

class _DisclosureState extends State<Disclosure> {
  bool _open = false;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => setState(() => _open = !_open),
        child: SizedBox(
          height: 46,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    widget.title,
                    style: TextStyle(
                      fontSize: 15.5,
                      fontWeight: FontWeight.w700,
                      color: Tw.ink,
                    ),
                  ),
                ),
                AnimatedRotation(
                  turns: _open ? 0.5 : 0,
                  duration: const Duration(milliseconds: 200),
                  child: Icon(Icons.expand_more, size: 20, color: Tw.ink2),
                ),
              ],
            ),
          ),
        ),
      ),
      AnimatedSize(
        duration: const Duration(milliseconds: 200),
        alignment: Alignment.topCenter,
        child: _open ? widget.child : const SizedBox(width: double.infinity),
      ),
    ],
  );
}

// -------------------------------------------------------- grouped rows

/// `.section-hd`: the title above a group (with an aside or actions).
class SectionLabel extends StatelessWidget {
  const SectionLabel(
    this.text, {
    super.key,
    this.trailing,
    this.icon,
    this.top = 14,
  });
  final String text;
  final Widget? trailing;
  final IconData? icon;

  /// Space above the title; with [gap] before it this makes the mockup's
  /// 26 px between sections.
  final double top;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(6, top, 6, 8),
    child: ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 32),
      child: Row(
        children: [
          if (icon != null) ...[
            Icon(icon, size: 17, color: Tw.ink2),
            const SizedBox(width: 6),
          ],
          Expanded(child: Text(text, style: Ds.title)),
          if (trailing != null)
            DefaultTextStyle.merge(
              style: TextStyle(fontSize: 13.5, color: Tw.ink2),
              child: trailing!,
            ),
        ],
      ),
    ),
  );
}

/// `.group`: rows in one surface, separated by hairlines that start after
/// the row icon ([inset]).
class GroupList extends StatelessWidget {
  const GroupList({super.key, required this.children, this.inset = 66});
  final List<Widget> children;
  final double inset;

  @override
  Widget build(BuildContext context) => Container(
    decoration: panelDecoration(),
    clipBehavior: Clip.antiAlias,
    child: Column(
      children: [
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0) Divider(height: 1, indent: inset),
          children[i],
        ],
      ],
    ),
  );
}

/// `.row`: icon, title (16/700), subtitle (13.5), trailing, chevron.
class ListRow extends StatelessWidget {
  const ListRow({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.onTap,
    this.selected = false,
    this.titleColor,
    this.enabled = true,
    this.below,
  });
  final String title;
  final Widget? subtitle;
  final Widget? leading;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool selected;
  final Color? titleColor;

  /// false dims the row (`.row:disabled`).
  final bool enabled;

  /// Extra content under the subtitle (a small strip, a progress line).
  final Widget? below;

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: enabled ? 1 : 0.48,
    child: Material(
      color: selected ? Tw.accentSoft : Tw.surface,
      child: InkWell(
        onTap: enabled ? onTap : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 66),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 10, 12),
            child: Row(
              children: [
                if (leading != null) ...[leading!, const SizedBox(width: 14)],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                          height: 1.45,
                          color: titleColor ?? Tw.ink,
                        ),
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 1),
                        DefaultTextStyle.merge(
                          style: Ds.secondary,
                          child: subtitle!,
                        ),
                      ],
                      if (below != null) below!,
                    ],
                  ),
                ),
                if (trailing != null) ...[
                  const SizedBox(width: 8),
                  DefaultTextStyle.merge(
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: Tw.ink2,
                    ),
                    child: trailing!,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

/// The chevron at the end of a navigable row (points left in RTL).
class RowChevron extends StatelessWidget {
  const RowChevron({super.key});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsetsDirectional.only(start: 4, end: 2),
    child: Icon(Icons.chevron_left, size: 20, color: Tw.ink3),
  );
}

// ------------------------------------------------------------- statuses

enum Tone { neutral, accent, success, warning, danger, info }

(Color bg, Color fg) toneColors(Tone t) => switch (t) {
  Tone.neutral => (Tw.neutralSoft, Tw.ink2),
  Tone.accent => (Tw.accentSoft, Tw.accentInk),
  Tone.success => (Tw.accentSoft, Tw.accentInk),
  Tone.warning => (Tw.warnSoft, Tw.warn),
  Tone.danger => (Tw.dangerSoft, Tw.danger),
  Tone.info => (Tw.infoSoft, Tw.info),
};

/// `.pill`: a status label («مدققة»، «بانتظار التدقيق»…).
class StatusBadge extends StatelessWidget {
  const StatusBadge(
    this.label, {
    super.key,
    this.tone = Tone.neutral,
    this.icon,
    this.small = false,
  });
  final String label;
  final Tone tone;
  final IconData? icon;
  final bool small;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = toneColors(tone);
    return Container(
      height: small ? 24 : 28,
      padding: EdgeInsets.symmetric(horizontal: small ? 9 : 11),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(99),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: small ? 13 : 15, color: fg),
            const SizedBox(width: 5),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: small ? 12 : 13,
              fontWeight: FontWeight.w700,
              color: fg,
            ),
          ),
        ],
      ),
    );
  }
}

/// A small coloured dot (connection state, colour settings).
class ColorDot extends StatelessWidget {
  const ColorDot(this.color, {super.key, this.size = 12});
  final Color color;
  final double size;
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      border: Border.all(color: Tw.surface, width: 2),
    ),
  );
}

/// `.dots`: the agent and management colours, overlapping.
class ColorDots extends StatelessWidget {
  const ColorDots(this.colors, {super.key});
  final List<Color> colors;
  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      for (var i = 0; i < colors.length; i++)
        Transform.translate(
          offset: Offset(i * 4.0, 0),
          child: ColorDot(colors[i]),
        ),
    ],
  );
}

// ---------------------------------------------------------- numbers

/// `.fig`: a number with its label (adjustment totals, summaries).
class StatTile extends StatelessWidget {
  StatTile({
    super.key,
    required this.label,
    required this.value,
    Color? color,
    this.bg,
    this.icon,
    this.selected = false,
  }) : color = color ?? Tw.ink;
  final String label;
  final String value;
  final Color color;
  final Color? bg;
  final IconData? icon;
  final bool selected;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 8),
    decoration: BoxDecoration(
      color: selected ? Tw.accentSoft : (bg ?? Tw.surface),
      borderRadius: BorderRadius.circular(16),
    ),
    child: Column(
      children: [
        if (icon != null) ...[
          Icon(icon, size: 18, color: color),
          const SizedBox(height: 4),
        ],
        Text(
          value,
          textDirection: TextDirection.ltr,
          style: TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w800,
            height: 1.3,
            color: color,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          label,
          textAlign: TextAlign.center,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: 12.5, color: Tw.ink2),
        ),
      ],
    ),
  );
}

/// `.figs`: three numbers in one surface separated by short hairlines.
class FigsRow extends StatelessWidget {
  const FigsRow({super.key, required this.figs, this.flat = false});

  /// (value, label, colour).
  final List<(String, String, Color?)> figs;
  final bool flat;

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      color: flat ? Tw.surface2 : Tw.surface,
      borderRadius: BorderRadius.circular(Ds.radius),
    ),
    child: IntrinsicHeight(
      child: Row(
        children: [
          for (var i = 0; i < figs.length; i++) ...[
            if (i > 0)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: VerticalDivider(width: 1, color: Tw.rule),
              ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  vertical: 16,
                  horizontal: 8,
                ),
                child: Column(
                  children: [
                    Text(
                      figs[i].$1,
                      textDirection: TextDirection.ltr,
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w800,
                        height: 1.3,
                        color: figs[i].$3 ?? Tw.ink,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      figs[i].$2,
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12.5, color: Tw.ink2),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    ),
  );
}

/// A result line: icon, label, value (with a tone) and an optional action.
class MetricRow extends StatelessWidget {
  const MetricRow({
    super.key,
    required this.icon,
    required this.label,
    required this.value,
    this.tone = Tone.neutral,
    this.onTap,
    this.color,
  });
  final IconData icon;
  final String label;
  final String value;
  final Tone tone;
  final VoidCallback? onTap;

  /// An exact colour (e.g. the agent / management colour of the audit)
  /// instead of [tone].
  final Color? color;

  @override
  Widget build(BuildContext context) {
    var (bg, fg) = toneColors(tone);
    if (tone == Tone.neutral) (bg, fg) = (Tw.surface2, Tw.ink2);
    if (color != null) {
      fg = color!;
      bg = color!.withValues(alpha: Tw.isDark ? 0.22 : 0.14);
    }
    return ListRow(
      title: label,
      leading: IconChip(icon, color: fg, bg: bg),
      onTap: onTap,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            value,
            textDirection: TextDirection.ltr,
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w800,
              color: tone == Tone.neutral && color == null ? Tw.ink : fg,
            ),
          ),
          if (onTap != null) const RowChevron() else const SizedBox(width: 6),
        ],
      ),
    );
  }
}

/// A circular progress with the percentage in the middle.
class ProgressRing extends StatelessWidget {
  ProgressRing({super.key, required this.value, this.size = 64, Color? color})
    : color = color ?? Tw.accent;

  /// 0..1, or null while the total is not known yet.
  final double? value;
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: Stack(
      alignment: Alignment.center,
      children: [
        SizedBox(
          width: size,
          height: size,
          child: CircularProgressIndicator(
            value: value,
            strokeWidth: 5,
            strokeCap: StrokeCap.round,
            backgroundColor: Tw.surface3,
            color: color,
          ),
        ),
        if (value != null)
          Text(
            '${(math.max(0, math.min(1, value!)) * 100).round()}%',
            textDirection: TextDirection.ltr,
            style: TextStyle(
              fontSize: size * 0.24,
              fontWeight: FontWeight.w800,
              color: Tw.ink,
            ),
          ),
      ],
    ),
  );
}

/// `.prog`: a thin accent progress line.
class ProgressLine extends StatelessWidget {
  const ProgressLine({super.key, this.value, this.height = 6});
  final double? value;
  final double height;
  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(99),
    child: LinearProgressIndicator(
      value: value,
      minHeight: height,
      color: Tw.accent,
      backgroundColor: Tw.surface3,
    ),
  );
}

// --------------------------------------------------------------- misc

/// A short grey summary line (folded panels, row summaries).
class SummaryText extends StatelessWidget {
  const SummaryText(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Text(
    text,
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
    style: Ds.secondary,
  );
}

/// `.field-label`: the label above a field.
class FieldHeader extends StatelessWidget {
  const FieldHeader(this.label, {super.key});
  final String label;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
    child: Text(label, style: Ds.label),
  );
}

/// `.caption`.
class Caption extends StatelessWidget {
  const Caption(this.text, {super.key, this.center = false, this.color});
  final String text;
  final bool center;
  final Color? color;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(6, 10, 6, 0),
    child: Text(
      text,
      textAlign: center ? TextAlign.center : TextAlign.start,
      style: Ds.caption.copyWith(color: color),
    ),
  );
}

/// `.frows`: label / control lines in one rounded block (forms in sheets
/// and on the field mapping page).
class FormRows extends StatelessWidget {
  const FormRows({super.key, required this.children, this.onSurface = true});
  final List<Widget> children;

  /// true inside a white sheet (surface-2 block); false on the page
  /// background (white block).
  final bool onSurface;

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      color: onSurface ? Tw.surface2 : Tw.surface,
      borderRadius: BorderRadius.circular(18),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0) Divider(height: 1, indent: 14, endIndent: 14),
          children[i],
        ],
      ],
    ),
  );
}

/// `.frow`: a label with its control at the end, or ([block]) the label
/// above a full-width control.
class FormRow extends StatelessWidget {
  const FormRow(this.label, this.control, {super.key, this.block = false});
  final String label;
  final Widget control;
  final bool block;

  @override
  Widget build(BuildContext context) =>
      block
          ? Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(label, style: Ds.label),
                const SizedBox(height: 8),
                control,
              ],
            ),
          )
          : ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 58),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      label,
                      style: TextStyle(fontSize: 15, color: Tw.ink),
                    ),
                  ),
                  const SizedBox(width: 12),
                  control,
                ],
              ),
            ),
          );
}

/// A friendly empty state with an optional action (`.empty`).
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
    this.action,
    this.leading,
  });
  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  /// Replaces the icon (e.g. the app logo on the welcome state).
  final Widget? leading;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(28, 40, 28, 24),
    child: Column(
      children: [
        leading ??
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(
                color: Tw.surface,
                borderRadius: BorderRadius.circular(20),
              ),
              alignment: Alignment.center,
              child: Icon(icon, size: 30, color: Tw.ink3),
            ),
        const SizedBox(height: 18),
        Text(
          title,
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 23,
            fontWeight: FontWeight.w800,
            color: Tw.ink,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          message,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 15, color: Tw.ink2, height: 1.75),
        ),
        if (action != null) ...[const SizedBox(height: 22), action!],
      ],
    ),
  );
}

// ------------------------------------------------------------ the strip

/// One part of a [ResultStrip]: a count and its colour; a null colour is
/// drawn hatched («غير موجود»).
typedef StripPart = (int count, Color? color);

/// `.strip` (owner's mockup): the audit outcome in the sheet's own colours
/// — the agent colour, the management colour, and a hatch for «غير موجود».
/// Grey when the period has not been audited. With [progress] the parts
/// fill from the start up to that fraction (running audit).
class ResultStrip extends StatelessWidget {
  const ResultStrip({
    super.key,
    required this.parts,
    this.height = 8,
    this.progress,
  });
  final List<StripPart> parts;
  final double height;
  final double? progress;

  @override
  Widget build(BuildContext context) {
    final total = parts.fold<int>(0, (a, p) => a + p.$1);
    final strip = ClipRRect(
      borderRadius: BorderRadius.circular(99),
      child: SizedBox(
        height: height,
        child:
            total == 0
                ? ColoredBox(color: Tw.surface3)
                : Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final (i, p) in parts.indexed)
                      if (p.$1 > 0) ...[
                        if (i > 0 && parts.take(i).any((q) => q.$1 > 0))
                          const SizedBox(width: 2),
                        Expanded(
                          flex: math.max(p.$1, total ~/ 60),
                          child:
                              p.$2 == null
                                  ? const HatchBox()
                                  : ColoredBox(color: p.$2!),
                        ),
                      ],
                  ],
                ),
      ),
    );
    if (progress == null) return strip;
    final f = math.max(0.0, math.min(1.0, progress!));
    return Stack(
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(99),
          child: SizedBox(
            height: height,
            child: ColoredBox(color: Tw.surface3),
          ),
        ),
        ClipRect(
          clipper: _StartClipper(f),
          child:
              total == 0
                  ? ClipRRect(
                    borderRadius: BorderRadius.circular(99),
                    child: SizedBox(
                      height: height,
                      child: ColoredBox(color: Tw.accent),
                    ),
                  )
                  : strip,
        ),
      ],
    );
  }
}

/// Keeps the first [fraction] of a box, from the reading start (right in
/// RTL), like the mockup's `clip-path` sweep.
class _StartClipper extends CustomClipper<Rect> {
  _StartClipper(this.fraction);
  final double fraction;
  @override
  Rect getClip(Size size) {
    final w = size.width * fraction;
    return Rect.fromLTWH(size.width - w, 0, w, size.height);
  }

  @override
  bool shouldReclip(_StartClipper old) => old.fraction != fraction;
}

/// `.s-none` / `.key.hatch`: diagonal lines on the neutral fill.
class HatchBox extends StatelessWidget {
  const HatchBox({super.key});
  @override
  Widget build(BuildContext context) => CustomPaint(
    painter: _HatchPainter(Tw.neutralSoft, Tw.hatch),
    child: const SizedBox.expand(),
  );
}

class _HatchPainter extends CustomPainter {
  _HatchPainter(this.bg, this.line);
  final Color bg;
  final Color line;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = bg);
    final p =
        Paint()
          ..color = line
          ..strokeWidth = 1.5;
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    for (var x = -size.height; x < size.width + size.height; x += 4.5) {
      canvas.drawLine(Offset(x, size.height), Offset(x + size.height, 0), p);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_HatchPainter old) => old.bg != bg || old.line != line;
}

/// `.key`: a 12 px colour square (hatched when [color] is null).
class ColorKey extends StatelessWidget {
  const ColorKey(this.color, {super.key, this.size = 12});
  final Color? color;
  final double size;
  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(4),
    child: SizedBox(
      width: size,
      height: size,
      child: color == null ? const HatchBox() : ColoredBox(color: color!),
    ),
  );
}

/// `.legend`: key, name, count and share of each outcome.
class ResultLegend extends StatelessWidget {
  const ResultLegend({super.key, required this.items});

  /// (name, count, colour or null for the hatch).
  final List<(String, int, Color?)> items;

  @override
  Widget build(BuildContext context) {
    final total = items.fold<int>(0, (a, s) => a + s.$2);
    return Column(
      children: [
        for (final it in items)
          SizedBox(
            height: 38,
            child: Row(
              children: [
                ColorKey(it.$3),
                const SizedBox(width: 10),
                Expanded(child: Text(it.$1, style: Ds.body)),
                Text(
                  formatCount(it.$2),
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                    color: Tw.ink,
                  ),
                ),
                SizedBox(
                  width: 52,
                  child: Text(
                    '${total == 0 ? 0 : (it.$2 * 100 / total).round()}%',
                    // `.lg-share`: at the far end of the line (left in RTL).
                    textAlign: TextAlign.left,
                    textDirection: TextDirection.ltr,
                    style: TextStyle(fontSize: 13.5, color: Tw.ink2),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// `<bdi dir="ltr">`: keeps a Latin / numeric run in its own direction
/// inside Arabic text.
String ltr(String s) => '\u2066$s\u2069';

/// `fmt`: 1240 → «1,240».
String formatCount(num n) {
  final neg = n < 0;
  final whole = n.abs().truncate();
  final frac = n.abs() - whole;
  final s = whole.toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  var out = b.toString();
  if (frac > 0) {
    final f = frac
        .toStringAsFixed(2)
        .substring(1)
        .replaceAll(RegExp(r'0+$'), '');
    if (f != '.') out += f;
  }
  return neg ? '-$out' : out;
}

/// Kept for the call sites written before the strip: the outcome bar with
/// a small legend.
class ResultsBar extends StatelessWidget {
  const ResultsBar({super.key, required this.segments});

  /// (label, count, colour) in display order.
  final List<(String, int, Color)> segments;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      ResultStrip(parts: [for (final s in segments) (s.$2, s.$3)]),
      const SizedBox(height: 8),
      Wrap(
        spacing: 14,
        runSpacing: 4,
        children: [
          for (final s in segments)
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ColorKey(s.$3, size: 10),
                const SizedBox(width: 5),
                Text(
                  '${s.$1} ${formatCount(s.$2)}',
                  style: TextStyle(fontSize: 12.5, color: Tw.ink2),
                ),
              ],
            ),
        ],
      ),
    ],
  );
}

/// `.seg`: a segmented choice (inquiry scope, appearance, data source).
class SegmentedChoice extends StatelessWidget {
  const SegmentedChoice({
    super.key,
    required this.options,
    required this.selected,
    required this.onChanged,
    this.icons,
  });
  final List<String> options;
  final List<IconData>? icons;
  final int selected;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) => Container(
    height: 46,
    padding: const EdgeInsets.all(3),
    decoration: BoxDecoration(
      color: Tw.surface3,
      borderRadius: BorderRadius.circular(13),
    ),
    child: Row(
      children: [
        for (var i = 0; i < options.length; i++) ...[
          if (i > 0) const SizedBox(width: 2),
          Expanded(
            child: Semantics(
              button: true,
              selected: i == selected,
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => onChanged(i),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 160),
                  decoration: BoxDecoration(
                    color: i == selected ? Tw.surface : Colors.transparent,
                    borderRadius: BorderRadius.circular(10),
                    boxShadow:
                        i == selected
                            ? const [
                              BoxShadow(
                                color: Color(0x1f0a1e14),
                                blurRadius: 3,
                                offset: Offset(0, 1),
                              ),
                            ]
                            : null,
                  ),
                  alignment: Alignment.center,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      if (icons != null) ...[
                        Icon(
                          icons![i],
                          size: 17,
                          color: i == selected ? Tw.ink : Tw.ink2,
                        ),
                        const SizedBox(width: 6),
                      ],
                      Flexible(
                        child: Text(
                          options[i],
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 14.5,
                            fontWeight: FontWeight.w700,
                            color: i == selected ? Tw.ink : Tw.ink2,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ],
    ),
  );
}
