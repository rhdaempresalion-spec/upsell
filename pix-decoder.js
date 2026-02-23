// Decodificador de código PIX (formato EMV)
// Extrai MERCHANT e ADQUIRENTE do código PIX

export function decodePIX(qrcode) {
  if (!qrcode) return { merchant: 'Desconhecido', acquirer: 'Desconhecido', full: 'Desconhecido' };
  
  try {
    const fields = {};
    let pos = 0;
    
    // Parse EMV format: ID(2) + LENGTH(2) + VALUE(LENGTH)
    while (pos < qrcode.length) {
      const id = qrcode.substring(pos, pos + 2);
      const length = parseInt(qrcode.substring(pos + 2, pos + 4));
      const value = qrcode.substring(pos + 4, pos + 4 + length);
      
      fields[id] = value;
      pos += 4 + length;
    }
    
    // Campo 59: Merchant Name
    const merchantName = fields['59'] || 'Desconhecido';
    
    // Campo 26: Merchant Account Information
    // Subcampo 25 contém a URL do adquirente
    let acquirer = 'Desconhecido';
    if (fields['26']) {
      const field26 = fields['26'];
      let subPos = 0;
      
      while (subPos < field26.length) {
        const subId = field26.substring(subPos, subPos + 2);
        const subLength = parseInt(field26.substring(subPos + 2, subPos + 4));
        const subValue = field26.substring(subPos + 4, subPos + 4 + subLength);
        
        // Subcampo 25 contém a URL
        if (subId === '25') {
          // Remover prefixos primeiro
          let cleanValue = subValue.replace(/^(qrcode|api|www)\./, '');
          // Extrair domínio (ex: pagsm.com.br)
          const domainMatch = cleanValue.match(/^([a-z0-9-]+\.com\.br|[a-z0-9-]+\.com|[a-z0-9-]+\.[a-z]{2,})/i);
          if (domainMatch) {
            acquirer = domainMatch[1];
          }
          break;
        }
        
        subPos += 4 + subLength;
      }
    }
    
    // Criar nomenclatura: MERCHANT/ADQUIRENTE
    const full = `${merchantName}/${acquirer}`;
    
    return {
      merchant: merchantName,
      acquirer: acquirer,
      full: full
    };
    
  } catch (error) {
    console.error('Erro ao decodificar PIX:', error);
    return { merchant: 'Erro', acquirer: 'Erro', full: 'Erro' };
  }
}

// Teste
if (import.meta.url === `file://${process.argv[1]}`) {
  const testQRCode = "00020101021226820014br.gov.bcb.pix2560qrcode.pagsm.com.br/pix/96769647-adb5-40f4-a4a2-e399aa1a31815204000053039865802BR5916VIXONSISTEMALTDA6008SaoPaulo62070503***63043998";
  
  console.log('Testando decodificador PIX:');
  console.log('QR Code:', testQRCode.substring(0, 50) + '...');
  console.log('\nResultado:', decodePIX(testQRCode));
  console.log('\n✅ Nomenclatura esperada: VIXONSISTEMALTDA/pagsm.com.br');
}
