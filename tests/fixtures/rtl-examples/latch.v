module latchy(input en, input d, output reg q);
always_comb begin
    if (en) q = d;
end
endmodule
