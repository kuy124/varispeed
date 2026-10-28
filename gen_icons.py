"""Generate extension icons. Run: python gen_icons.py

Tachometer palette, same tokens as the popup: ink ground, one amber signal,
an amber bezel so the tile still reads on a dark toolbar.
"""
from PIL import Image, ImageDraw

S = 1024  # supersample, then downsample for clean edges
CY = 0.5
INK = (14, 15, 17)
INK_TOP = (23, 25, 28)
AMBER = (255, 176, 32, 255)
BEZEL = (255, 176, 32, 90)


def unit(x, y):
    return (x * S, y * S)


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def background():
    # flat ink, very slightly lifted at the top so the tile is not a dead square
    grad = Image.new('RGB', (S, S))
    d = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(INK_TOP, INK)))
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), rounded_mask(S, round(S * 0.22)))
    return img


def draw_art(img, small=False):
    d = ImageDraw.Draw(img)

    # bezel: keeps the dark tile visible on a dark browser toolbar
    inset = 0.035
    d.rounded_rectangle(
        [*unit(inset, inset), *unit(1 - inset, 1 - inset)],
        radius=S * 0.19, outline=BEZEL, width=max(2, round(S * 0.018)),
    )

    # Speed lines only at 128. Below that they are too short to read as motion
    # and collapse into an ellipsis, so smaller sizes are chevron only.
    if not small:
        for y0, a in [(CY - 0.21, 120), (CY, 220), (CY + 0.21, 120)]:
            d.rounded_rectangle(
                [*unit(0.11, y0 - 0.030), *unit(0.30, y0 + 0.030)],
                radius=S * 0.030, fill=(255, 176, 32, a),
            )

    # double fast-forward chevron
    h, pair = (0.245, [(0.47, 0.66), (0.65, 0.84)]) if not small else \
              (0.30, [(0.30, 0.52), (0.52, 0.74)])
    for x0, x1 in pair:
        d.polygon([unit(x0, CY - h), unit(x1, CY), unit(x0, CY + h)], fill=AMBER)


def draw_art_16(img):
    """16px: two chevrons kept, but thick and tight. One chevron reads as Play."""
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(
        [*unit(0.02, 0.02), *unit(0.98, 0.98)],
        radius=S * 0.20, outline=(255, 176, 32, 70), width=round(S * 0.02),
    )
    h = 0.34
    for x0, x1 in [(0.20, 0.55), (0.50, 0.85)]:
        d.polygon([unit(x0, CY - h), unit(x1, CY), unit(x0, CY + h)], fill=AMBER)


def main():
    for size in (32, 48, 128):
        img = background()
        # Speed lines are only legible at 128; at 48 they read as a menu icon.
        draw_art(img, small=size < 128)
        img.resize((size, size), Image.LANCZOS).save(f'icon{size}.png')
    img = background()
    draw_art_16(img)
    img.resize((16, 16), Image.LANCZOS).save('icon16.png')
    print('wrote icon16/32/48/128.png')


if __name__ == '__main__':
    main()
