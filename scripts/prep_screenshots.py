#!/usr/bin/env python3
"""
Prep screenshots for the Chrome Web Store.

Turns any image (any size, any aspect, with or without transparency) into a
store-compliant 1280x800, 24-bit PNG with NO alpha channel.

Usage:
    python3 scripts/prep_screenshots.py <input_folder_or_files...> [--out DIR] [--mode contain|cover] [--jpg]

Examples:
    python3 scripts/prep_screenshots.py ~/Desktop/proofr-shots
    python3 scripts/prep_screenshots.py shot1.png shot2.png --out store-screenshots
    python3 scripts/prep_screenshots.py ~/Desktop/proofr-shots --mode cover

Modes:
    contain (default) - fit the whole image inside 1280x800 and pad the edges
                        with the paper color. Never crops. Safest.
    cover             - fill 1280x800 completely and crop the overflow. No
                        padding, but trims edges. Use if your shots are already
                        ~1.6:1 and you want them edge-to-edge.
"""
import sys
import os
from PIL import Image

TARGET = (1280, 800)
PAPER = (250, 249, 247)  # #faf9f7, matches Proofr so any padding blends in
EXTS = ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff')


def flatten(img):
    """Drop transparency by compositing onto the paper color -> RGB."""
    if img.mode in ('RGBA', 'LA', 'P'):
        img = img.convert('RGBA')
        bg = Image.new('RGB', img.size, PAPER)
        bg.paste(img, mask=img.split()[-1])
        return bg
    return img.convert('RGB')


def fit(img, mode):
    w, h = img.size
    if mode == 'cover':
        scale = max(TARGET[0] / w, TARGET[1] / h)
        nw, nh = round(w * scale), round(h * scale)
        img = img.resize((nw, nh), Image.LANCZOS)
        left, top = (nw - TARGET[0]) // 2, (nh - TARGET[1]) // 2
        return img.crop((left, top, left + TARGET[0], top + TARGET[1]))
    # contain
    scale = min(TARGET[0] / w, TARGET[1] / h)
    nw, nh = round(w * scale), round(h * scale)
    img = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGB', TARGET, PAPER)
    canvas.paste(img, ((TARGET[0] - nw) // 2, (TARGET[1] - nh) // 2))
    return canvas


def collect(paths):
    files = []
    for p in paths:
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                if name.lower().endswith(EXTS) and not name.startswith('.'):
                    files.append(os.path.join(p, name))
        elif os.path.isfile(p):
            files.append(p)
        else:
            print(f"  ! skipped (not found): {p}")
    return files


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    out = 'store-screenshots'
    mode = 'contain'
    as_jpg = False
    inputs = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--out':
            out = args[i + 1]; i += 2
        elif a == '--mode':
            mode = args[i + 1]; i += 2
        elif a == '--jpg':
            as_jpg = True; i += 1
        else:
            inputs.append(a); i += 1

    files = collect(inputs)
    if not files:
        print("No images found. Point it at a folder or list image files.")
        sys.exit(1)

    os.makedirs(out, exist_ok=True)
    print(f"Output: {out}/  ({mode} mode)  {len(files)} image(s)\n")

    for n, path in enumerate(files, 1):
        img = Image.open(path)
        src = img.size
        img = fit(flatten(img), mode)
        ext = 'jpg' if as_jpg else 'png'
        dest = os.path.join(out, f"screenshot-{n}.{ext}")
        if as_jpg:
            img.save(dest, 'JPEG', quality=92)
        else:
            img.save(dest, 'PNG')  # RGB -> 24-bit, no alpha
        print(f"  {os.path.basename(path)}  {src[0]}x{src[1]}  ->  {dest}  1280x800")

    print(f"\nDone. Upload the {len(files)} file(s) from {out}/ to the Chrome Web Store.")


if __name__ == '__main__':
    main()
