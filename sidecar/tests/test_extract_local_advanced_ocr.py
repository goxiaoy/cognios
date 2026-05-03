"""Local advanced OCR result normalization."""

from __future__ import annotations

from search_sidecar.extract.local_advanced_ocr import _results_to_markdown


def test_results_to_markdown_normalizes_paddle_html_tables():
    raw = """
    <div style="text-align: center;"><img src="imgs/logo.jpg" alt="Image" /></div>
    <div style="text-align: center;">电子发票头普通发票）</div>
    发票号码：26332000001621674421

    <div style="text-align: center;"><html><body><table border="1"><tbody>
      <tr><td>购买方信息</td><td>名称：肖裕（个人）</td><td>销售方信息</td></tr>
      <tr><td>项目名称</td><td>检查材料费</td><td>￥5.00</td></tr>
    </tbody></table></body></html></div>
    """

    text = _results_to_markdown({"markdown": {"markdown_texts": raw}})

    assert "电子发票头普通发票）" in text
    assert "发票号码：26332000001621674421" in text
    assert "| 购买方信息 | 名称：肖裕（个人） | 销售方信息 |" in text
    assert "| --- | --- | --- |" in text
    assert "<table" not in text
    assert "<div" not in text
    assert "<img" not in text
    assert "src=" not in text
