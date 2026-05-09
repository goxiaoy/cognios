"""Local advanced OCR result extraction."""

from __future__ import annotations

from search_sidecar.extract.local_advanced_ocr import _results_to_markdown


def test_results_to_markdown_preserves_paddle_markdown_html():
    raw = """
    <div style="text-align: center;"><img src="imgs/logo.jpg" alt="Image" /></div>
    <div style="text-align: center;">电子发票头普通发票）</div>
    发票号码：26332000001621674421

    <div style="text-align: center;"><html><body><table border="1"><tbody>
      <tr><td>购买方信息</td><td>名称：肖裕（个人）</td><td>销售方信息</td></tr>
      <tr><td>项目名称</td><td>检查材料费</td><td>￥5.00</td></tr>
    </tbody></table></body></html></div>
    """

    artifact = _results_to_markdown(
        {
            "markdown": {
                "markdown_texts": raw,
                "markdown_images": {"imgs/logo.jpg": object()},
            }
        }
    )
    text = artifact.text

    assert "电子发票头普通发票）" in text
    assert "发票号码：26332000001621674421" in text
    assert "<table" in text
    assert "<div" in text
    assert "<img" in text
    assert "src=" in text
    assert "购买方信息" in text
    assert "imgs/logo.jpg" in artifact.images


def test_results_to_markdown_renames_duplicate_image_keys():
    first = {
        "markdown": {
            "markdown_texts": '<img src="imgs/crop.jpg" alt="a" />',
            "markdown_images": {"imgs/crop.jpg": object()},
        }
    }
    second = {
        "markdown": {
            "markdown_texts": '<img src="imgs/crop.jpg" alt="b" />',
            "markdown_images": {"imgs/crop.jpg": object()},
        }
    }

    artifact = _results_to_markdown([first, second])

    assert "imgs/crop.jpg" in artifact.images
    assert "imgs/crop-2.jpg" in artifact.images
    assert 'src="imgs/crop-2.jpg"' in artifact.text
