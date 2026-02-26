const ExcelJS = require('exceljs');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { rows } = req.body;
        if (!rows || !Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ error: 'No rows provided.' });
        }

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'MailHarvest';
        workbook.created = new Date();

        const sheet = workbook.addWorksheet('Contacts', {
            headerFooter: { firstHeader: 'MailHarvest — Scraped Contacts' }
        });

        sheet.columns = [
            { header: 'S.No', key: 'sno', width: 8 },
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Designation', key: 'designation', width: 35 },
            { header: 'Email', key: 'email', width: 40 },
            { header: 'Validation', key: 'validation', width: 14 },
            { header: 'Validation Note', key: 'validationNote', width: 45 },
            { header: 'Domain', key: 'domain', width: 30 },
            { header: 'Source Page', key: 'source', width: 50 },
        ];

        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C63FF' } };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
        headerRow.height = 28;

        rows.forEach((row, index) => {
            const dataRow = sheet.addRow({
                sno: index + 1,
                name: row.name || '',
                designation: row.designation || '',
                email: row.email || '',
                validation: (row.validationStatus || 'unchecked').toUpperCase(),
                validationNote: row.validationReason || '',
                domain: row.domain || '',
                source: row.source || '',
            });

            const valCell = dataRow.getCell('validation');
            if (row.validationStatus === 'valid') {
                valCell.font = { color: { argb: 'FF22C55E' }, bold: true };
            } else if (row.validationStatus === 'catchall') {
                valCell.font = { color: { argb: 'FFF59E0B' }, bold: true };
            } else if (row.validationStatus === 'invalid') {
                valCell.font = { color: { argb: 'FFF43F5E' }, bold: true };
            }

            if (index % 2 === 0) {
                dataRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5FF' } };
            }
            dataRow.alignment = { vertical: 'middle' };
        });

        sheet.autoFilter = { from: 'A1', to: `H${rows.length + 1}` };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=mailharvest_${Date.now()}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: 'Failed to generate Excel file.' });
    }
};

module.exports.config = { maxDuration: 30 };
